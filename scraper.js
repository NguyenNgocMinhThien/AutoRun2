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

const MAX_PER_KW    = 30; // crawl nhiều để lọc đủ job $250k+  // crawl nhiều để lọc đủ job $250k+
const FROMAGE       = 14;  // mở rộng 14 ngày
const FETCH_DETAIL  = true;
const MIN_SALARY_YEAR  = 250000;
const MIN_SALARY_HOUR  = 120;

const SPREADSHEET_ID = '1n-Vkvrbt6fAo_6tU5KKx54cmn_J64mRyHbSvPi7tDX0';
const SHEET_NAME     = 'Job indeed';
// =====================================================

// Format ngày dạng string DD/MM/YYYY — tránh Google Sheets đọc thành serial number
const now   = new Date();
const dd    = String(now.getDate()).padStart(2, '0');
const mm    = String(now.getMonth() + 1).padStart(2, '0');
const yyyy  = now.getFullYear();
const TODAY = `${dd}/${mm}/${yyyy}`; // "08/05/2026"

function dedup(jobs) {
    const seen = new Set();
    return jobs.filter(j => {
        const key = `${j.Title}|${j.Company}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Lọc salary >= $250k/năm hoặc >= $120/giờ
function salaryQualifies(salaryText) {
    if (!salaryText || salaryText === 'N/A') return false;
    const cleaned = salaryText.replace(/,/g, '');
    const nums = [...cleaned.matchAll(/\$?([\d.]+)/g)].map(m => parseFloat(m[1]));
    if (!nums.length) return false;
    const isHour = /hour|hr/i.test(salaryText);
    const isYear = /year|yr|annual/i.test(salaryText);
    for (const n of nums) {
        if (isHour && n >= MIN_SALARY_HOUR) return true;
        if (isYear && n >= MIN_SALARY_YEAR) return true;
        if (!isHour && !isYear && n >= MIN_SALARY_YEAR) return true;
    }
    return false;
}

async function scraperGet(url) {
    return axios.get('https://api.scraperapi.com/', {
        params: { api_key: process.env.SCRAPER_API_KEY, url, country_code: 'us' },
        timeout: 90000
    });
}

function parseSalary($, root) {
    const node = root ? $(root) : $('body');
    const selectors = [
        '[data-testid="attribute_snippet_testid"]',
        '[data-testid="salary-snippet"]',
        '[data-testid="salaryInfoAndJobType"]',
        '.salary-snippet-container',
        '.estimated-salary-container',
        '[class*="salary"]',
        '[class*="Salary"]',
        '[class*="salaryInfo"]',
        '.jobsearch-JobMetadataHeader-item',
        '[data-testid="jobsearch-JobMetadataHeader-salaryInfoAndJobType"]'
    ];
    for (const sel of selectors) {
        const t = node.find(sel).first().text().replace(/\s+/g, ' ').trim();
        if (t && t.includes('$')) return cleanSalary(t);
    }
    const bodyText = node.text().replace(/\s+/g, ' ');
    const m = bodyText.match(/\$[\d,]+(?:\.\d+)?\s*(?:[-–]\s*\$[\d,]+(?:\.\d+)?)?\s*(?:a year|an hour|per year|per hour|\/hr|\/year)/i);
    if (m) return cleanSalary(m[0]);
    return '';
}

function cleanSalary(s) {
    return s.replace(/Full-time|Part-time|Permanent|Contract|Temporary/gi, '')
            .replace(/\+\d+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
}

async function fetchDetailSalary(link) {
    try {
        await new Promise(r => setTimeout(r, 1200));
        const res = await scraperGet(link);
        const $   = cheerio.load(res.data);
        return parseSalary($, null);
    } catch { return ''; }
}

async function scrapeKeywordLocation(kw, location) {
    const q   = encodeURIComponent(kw);
    const l   = encodeURIComponent(location);
    const url = `https://www.indeed.com/jobs?q=${q}&l=${l}&radius=50&fromage=${FROMAGE}`;

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
                const href    = titleEl.attr('href') || '';
                const link    = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
                const salary  = parseSalary($, el);
                const loc     = $(el).find('[data-testid="text-location"], .companyLocation').text().trim() || location;
                const company = $(el).find('[data-testid="company-name"], .companyName').text().trim() || 'N/A';
                const quick   = $(el).find('[data-testid="indeedApplyButton"], .iaIcon').length > 0;
                // Lấy page number nếu có
                cards.push({ title, company, salary, loc, link, quick });
            });

            const jobs = [];
            for (const c of cards) {
                let salary = c.salary;
                if (!salary && FETCH_DETAIL && c.link !== 'N/A') {
                    salary = await fetchDetailSalary(c.link);
                }
                // Bỏ qua nếu không đạt $250k
                if (!salaryQualifies(salary)) continue;

                jobs.push({
                    Company:      c.company,
                    Title:        c.title,
                    Link:         c.link,
                    Salary:       salary,
                    Location:     c.loc,
                    Page:         1,
                    EasilyApply:  c.quick ? 'Indeed Quick Apply' : 'Company Website',
                    DateCrawled:  TODAY,
                    CrawledBy:    ''
                });
            }

            console.log(`  ✅ [${location}] "${kw}" → ${jobs.length} jobs`);
            return jobs;

        } catch (err) {
            console.warn(`  ⚠️ Lần ${attempt} [${location}] "${kw}" — ${err.response?.status ?? err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
        }
    }
    return [];
}

// ==================== GOOGLE SHEETS ====================

async function appendToGoogleSheet(jobs) {
    try {
        const serviceAccountJson = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
            console.warn("⚠️ Thiếu GDRIVE_SERVICE_ACCOUNT_JSON — bỏ qua Google Sheets");
            return;
        }

        const credentials = JSON.parse(serviceAccountJson);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Map data theo đúng thứ tự cột: A=CompanyName, B=Job Title, C=Link, D=Salary, E=Location, F=Page, G=Easily Apply, H=Ngày lấy job, I=Người Crawl Data
        const rows = jobs.map(j => [
            j.Company,
            j.Title,
            j.Link,
            j.Salary,
            j.Location,
            j.Page,
            j.EasilyApply,  // Apply Method
            `'${j.DateCrawled}`,  // dấu ' đầu = force Google Sheets đọc là text
            j.CrawledBy
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range:         `${SHEET_NAME}!A:I`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: rows }
        });

        console.log(`✅ [Google Sheets] Đã append ${jobs.length} rows vào "${SHEET_NAME}"`);
    } catch (e) {
        console.error("❌ [Google Sheets] Lỗi:", e.message);
    }
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
    } catch (e) {
        console.error("❌ Catbox:", e.message);
        return `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`;
    }
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
                    { title: "Nguồn:",   value: "Indeed US" },
                    { title: "Khu vực:", value: "California" },
                    { title: "Số job:",  value: `${n}` },
                    { title: "Status:",  value: "✅ Đã ghi Google Sheets" }
                ]}
            ],
            actions: [
                { type: "Action.OpenUrl", title: "📊 Mở Google Sheet", url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=158387611` },
                { type: "Action.OpenUrl", title: "📥 Tải Excel",       url: fileLink }
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
    console.log(`📋 ${KEYWORDS.length} keywords | Max ${MAX_PER_KW}/keyword | Sheet: "${SHEET_NAME}"\n`);

    if (!process.env.SCRAPER_API_KEY) { console.error("❌ Thiếu SCRAPER_API_KEY!"); process.exit(1); }

    let allJobs = [];

    for (const kw of KEYWORDS) {
        let kwJobs = [];
        for (const loc of LOCATIONS) {
            if (kwJobs.length >= MAX_PER_KW) break;
            const jobs = await scrapeKeywordLocation(kw, loc);
            kwJobs.push(...jobs);
            await new Promise(r => setTimeout(r, 2000));
        }
        kwJobs = dedup(kwJobs).slice(0, MAX_PER_KW);
        console.log(`  → "${kw}": ${kwJobs.length} jobs\n`);
        allJobs.push(...kwJobs);
    }

    allJobs = dedup(allJobs);
    console.log(`📦 Tổng: ${allJobs.length} jobs`);

    if (!allJobs.length) {
        await sendTelegramAlert("❌ Indeed US/CA: Không có job nào.");
        return;
    }

    // Ghi Google Sheets
    await appendToGoogleSheet(allJobs);

    // Xuất Excel backup
    const fileName = `Indeed_US_CA_${new Date().toISOString().slice(0,10)}.xlsx`;
    const ws = XLSX.utils.json_to_sheet(allJobs);
    ws['!cols'] = Object.keys(allJobs[0]).map(k => ({
        wch: Math.min(60, Math.max(k.length + 2, ...allJobs.map(r => String(r[k]||'').length)))
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jobs");
    XLSX.writeFile(wb, fileName);
    console.log(`📊 Backup Excel → ${fileName}`);

    const fileLink = await uploadToCatbox(fileName);
    await Promise.all([
        sendTelegramAlert(
            `✅ <b>Indeed US / California</b>\n` +
            `<b>${allJobs.length} jobs</b> đã ghi vào Google Sheets\n` +
            `📊 <a href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=158387611">Mở Sheet</a>\n` +
            `📎 <a href="${fileLink}">Tải Excel</a>`
        ),
        sendTelegramFile(fileName),
        sendToTeams(allJobs.length, fileLink)
    ]);
    console.log("🏁 Hoàn tất!");
}

runScraper();