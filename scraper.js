import axios from 'axios';
import * as cheerio from 'cheerio';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import { google } from 'googleapis';

// ==================== CẤU HÌNH ====================
const KEYWORDS = [
    "analytics",
    "artificial intelligence",
    "data scientist",
    "finance",
    "financial analyst",
    "investment",
    "investment management",
    "machine learning",
    "systems analyst",
    "technology manager"
];

const LOCATIONS = [
    "Los Angeles, CA",
    "San Francisco, CA",
    "San Jose, CA"
];

const MAX_PER_KW       = 10;
const FROMAGE          = 14;
const FETCH_DETAIL     = true;
const MIN_SALARY_YEAR  = 250000;
const MIN_SALARY_HOUR  = 120;
const CONCURRENCY      = 1;   // tuần tự hoàn toàn tránh rate limit

const SPREADSHEET_ID = '1vUcKAbDazlC_vFSjzty02Fdugu4Nw_jZsEG2k_wyxXY';
const SHEET_NAME     = 'Job indeed';
const SHEET_GID      = '158387611';
// =====================================================

const now   = new Date();
const dd    = String(now.getDate()).padStart(2, '0');
const mm    = String(now.getMonth() + 1).padStart(2, '0');
const yyyy  = now.getFullYear();
const TODAY = `${dd}/${mm}/${yyyy}`;

// Chạy tối đa N tasks song song, có delay giữa các batch
async function parallelLimit(tasks, limit, delayMs = 3000) {
    const results = new Array(tasks.length);
    let idx = 0;

    async function worker() {
        while (idx < tasks.length) {
            const i = idx++;
            results[i] = await Promise.resolve().then(tasks[i]);
            if (idx < tasks.length) await new Promise(r => setTimeout(r, delayMs));
        }
    }

    await Promise.all(Array.from({ length: limit }, worker));
    return results;
}

function dedup(jobs) {
    const seen = new Set();
    return jobs.filter(j => {
        const key = `${j.Title}|${j.Company}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function salaryQualifies(salaryText) {
    if (!salaryText || salaryText === 'N/A') return false;
    const isHour = /hour|hr|\/hr/i.test(salaryText);
    const isYear = /year|yr|annual|\/yr/i.test(salaryText);
    const isWeek = /week|\/wk/i.test(salaryText);
    const isMon  = /month|\/mo/i.test(salaryText);
    const cleaned = salaryText.replace(/,/g, '');
    const nums = [...cleaned.matchAll(/(\d+(?:\.\d+)?)/g)]
        .map(m => parseFloat(m[1])).filter(n => n > 0);
    if (!nums.length) return false;
    const maxNum = Math.max(...nums);
    if (isHour) return maxNum >= MIN_SALARY_HOUR;
    if (isYear) return maxNum >= MIN_SALARY_YEAR;
    if (isWeek) return (maxNum * 52) >= MIN_SALARY_YEAR;
    if (isMon)  return (maxNum * 12) >= MIN_SALARY_YEAR;
    if (maxNum >= 1000) return maxNum >= MIN_SALARY_YEAR;
    return maxNum >= MIN_SALARY_HOUR;
}

async function scraperGet(url) {
    return axios.get('https://api.scraperapi.com/', {
        params: {
            api_key:      process.env.SCRAPER_API_KEY,
            url,
            country_code: 'us',
            render:       'false',  // tắt render để nhanh hơn và tránh 500
            keep_headers: 'true'
        },
        timeout: 120000
    });
}

function parseSalary($, root) {
    const node = root ? $(root) : $('body');
    const selectors = [
        '[data-testid="attribute_snippet_testid"]', '[data-testid="salary-snippet"]',
        '[data-testid="salaryInfoAndJobType"]', '.salary-snippet-container',
        '.estimated-salary-container', '[class*="salary"]', '[class*="Salary"]',
        '[class*="salaryInfo"]', '.jobsearch-JobMetadataHeader-item',
        '[data-testid="jobsearch-JobMetadataHeader-salaryInfoAndJobType"]'
    ];
    for (const sel of selectors) {
        const t = node.find(sel).first().text().replace(/\s+/g, ' ').trim();
        if (t && t.includes('$')) return cleanSalary(t);
    }
    const m = node.text().replace(/\s+/g, ' ')
        .match(/\$[\d,]+(?:\.\d+)?\s*(?:[-]\s*\$[\d,]+(?:\.\d+)?)?\s*(?:a year|an hour|per year|per hour|\/hr|\/year)/i);
    if (m) return cleanSalary(m[0]);
    return '';
}

function cleanSalary(s) {
    return s.replace(/Full-time|Part-time|Permanent|Contract|Temporary/gi, '')
            .replace(/\+\d+/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchDetailSalary(link) {
    try {
        const res = await scraperGet(link);
        return parseSalary(cheerio.load(res.data), null);
    } catch { return ''; }
}

async function scrapeKeywordLocation(kw, location) {
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(kw)}&l=${encodeURIComponent(location)}&radius=50&fromage=${FROMAGE}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await scraperGet(url);
            const $   = cheerio.load(res.data);
            const cards = [];

            $('.job_seen_beacon').each((i, el) => {
                if (cards.length >= MAX_PER_KW) return false;
                const titleEl = $(el).find('h2.jobTitle a, a.jcs-JobTitle');
                const title   = titleEl.text().trim() || $(el).find('h2.jobTitle').text().trim();
                if (!title) return;
                const href = titleEl.attr('href') || '';
                const link = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
                cards.push({
                    title, link,
                    salary:  parseSalary($, el),
                    loc:     $(el).find('[data-testid="text-location"], .companyLocation').text().trim() || location,
                    company: $(el).find('[data-testid="company-name"], .companyName').text().trim() || 'N/A',
                    quick:   $(el).find('[data-testid="indeedApplyButton"], .iaIcon').length > 0
                });
            });

            // Fetch detail salary song song (không tuần tự)
            const detailTasks = cards
                .filter(c => !c.salary && FETCH_DETAIL && c.link !== 'N/A')
                .map(c => async () => {
                    c.salary = await fetchDetailSalary(c.link);
                });
            await parallelLimit(detailTasks, 3); // 3 detail fetch song song

            const jobs = cards
                .filter(c => salaryQualifies(c.salary))
                .map(c => ({
                    Company:     c.company,
                    Title:       c.title,
                    Link:        c.link,
                    Salary:      c.salary,
                    Location:    c.loc,
                    Page:        1,
                    EasilyApply: c.quick ? 'Indeed Quick Apply' : 'Company Website',
                    DateCrawled: TODAY,
                    CrawledBy:   ''
                }));

            console.log(`  ✅ [${location}] "${kw}" → ${jobs.length} jobs`);
            return jobs;

        } catch (err) {
            console.warn(`  ⚠️ Lần ${attempt} [${location}] "${kw}" — ${err.response?.status ?? err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 8000));
        }
    }
    return [];
}

// ==================== GOOGLE SHEETS ====================

async function appendToGoogleSheet(jobs) {
    try {
        const serviceAccountJson = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) { console.warn("⚠️ Thiếu GDRIVE_SERVICE_ACCOUNT_JSON"); return; }
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(serviceAccountJson),
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const rows = jobs.map(j => [
            j.Company, j.Title, j.Link, j.Salary, j.Location,
            j.Page, j.EasilyApply, `'${j.DateCrawled}`, j.CrawledBy
        ]);
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:I`,
            valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
            requestBody: { values: rows }
        });
        console.log(`✅ [Google Sheets] Đã append ${jobs.length} rows vào "${SHEET_NAME}"`);
    } catch (e) { console.error("❌ [Google Sheets] Lỗi:", e.message); }
}

// ==================== UPLOAD & NOTIFY ====================

async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(filePath));
        const res  = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, { headers: form.getHeaders() });
        const link = res.data.trim();
        if (link.includes('https://')) return link;
        throw new Error(link);
    } catch (e) { console.error("❌ Catbox:", e.message); return `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`; }
}

async function sendToTeams(n, fileLink) {
    const url = process.env.TEAMS_WEBHOOK_URL;
    if (!url) return;
    try {
        await axios.post(url, {
            type: "AdaptiveCard", version: "1.4",
            body: [
                { type: "TextBlock", text: "🚀 JOB MỚI — CALIFORNIA US", weight: "Bolder", size: "Medium", color: "Accent" },
                { type: "FactSet", facts: [
                    { title: "Nguồn:", value: "Indeed US" }, { title: "Khu vực:", value: "California" },
                    { title: "Số job:", value: `${n}` },     { title: "Status:", value: "✅ Đã ghi Google Sheets" }
                ]}
            ],
            actions: [
                { type: "Action.OpenUrl", title: "📊 Mở Google Sheet", url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${SHEET_GID}#gid=${SHEET_GID}` },
                { type: "Action.OpenUrl", title: "📥 Tải Excel", url: fileLink }
            ],
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json"
        });
        console.log("✅ [Teams] Gửi thành công!");
    } catch (e) { console.error("❌ [Teams]:", e.message); }
}

async function sendTelegramAlert(msg) {
    const { TELEGRAM_TOKEN: t, TELEGRAM_CHAT_ID: c } = process.env;
    if (!t || !c) return;
    try { await axios.post(`https://api.telegram.org/bot${t}/sendMessage`, { chat_id: c, text: msg, parse_mode: 'HTML' }); }
    catch (e) { console.error("❌ Telegram:", e.message); }
}

async function sendTelegramFile(filePath) {
    const { TELEGRAM_TOKEN: t, TELEGRAM_CHAT_ID: c } = process.env;
    if (!t || !c || !fs.existsSync(filePath)) return;
    const form = new FormData();
    form.append('chat_id', c);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${t}/sendDocument`, form, { headers: form.getHeaders() });
        console.log("✅ [Telegram] File đã gửi!");
    } catch (e) { console.error("❌ Telegram File:", e.message); }
}

// ==================== MAIN ====================

async function runScraper() {
    console.log("🚀 Indeed US Scraper — California");
    console.log(`📋 ${KEYWORDS.length} keywords × ${LOCATIONS.length} vùng | Concurrency: ${CONCURRENCY} | Sheet: "${SHEET_NAME}"\n`);
    if (!process.env.SCRAPER_API_KEY) { console.error("❌ Thiếu SCRAPER_API_KEY!"); process.exit(1); }

    // Tạo tất cả task (keyword × location) rồi chạy song song
    const allTasks = [];
    for (const kw of KEYWORDS) {
        for (const loc of LOCATIONS) {
            allTasks.push(() => scrapeKeywordLocation(kw, loc));
        }
    }

    console.log(`⚡ Chạy ${allTasks.length} tasks song song (${CONCURRENCY} cùng lúc)...\n`);
    const results = await parallelLimit(allTasks, CONCURRENCY);

    // Gộp và giới hạn MAX_PER_KW cho mỗi keyword
    const jobsByKw = {};
    for (const kw of KEYWORDS) jobsByKw[kw] = [];

    for (const jobs of results) {
        for (const job of jobs) {
            const kw = job._kw || KEYWORDS.find(k => job.Title?.toLowerCase().includes(k) || job.Keyword === k) || 'other';
            if (!jobsByKw[kw]) jobsByKw[kw] = [];
            jobsByKw[kw].push(job);
        }
    }

    let allJobs = results.flat();
    allJobs = dedup(allJobs);

    console.log(`📦 Tổng: ${allJobs.length} jobs`);
    if (!allJobs.length) { await sendTelegramAlert("❌ Indeed US/CA: Không có job nào."); return; }

    await appendToGoogleSheet(allJobs);

    const fileName = `Indeed_US_CA_${new Date().toISOString().slice(0,10)}.xlsx`;
    const ws = XLSX.utils.json_to_sheet(allJobs);
    ws['!cols'] = Object.keys(allJobs[0]).map(k => ({
        wch: Math.min(60, Math.max(k.length + 2, ...allJobs.map(r => String(r[k]||'').length)))
    }));
    const lastCol = String.fromCharCode(64 + Object.keys(allJobs[0]).length);
    ws['!autofilter'] = { ref: `A1:${lastCol}1` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jobs");
    XLSX.writeFile(wb, fileName);
    console.log(`📊 Excel → ${fileName}`);

    const fileLink = await uploadToCatbox(fileName);
    await Promise.all([
        sendTelegramAlert(`✅ <b>Indeed US / California</b>\n<b>${allJobs.length} jobs</b>\n📊 <a href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${SHEET_GID}#gid=${SHEET_GID}">Mở Sheet</a>\n📎 <a href="${fileLink}">Tải Excel</a>`),
        sendTelegramFile(fileName),
        sendToTeams(allJobs.length, fileLink)
    ]);
    console.log("🏁 Hoàn tất!");
}

runScraper();