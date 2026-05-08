import axios from 'axios';
import * as cheerio from 'cheerio';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';

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

const MAX_PER_KW  = 8;
const FROMAGE     = 7;
const FETCH_DETAIL = true; // false = nhanh hơn nhưng salary ít hơn
// =====================================================

function dedup(jobs) {
    const seen = new Set();
    return jobs.filter(j => {
        const key = `${j.Title}|${j.Company}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function scraperGet(url) {
    return axios.get('https://api.scraperapi.com/', {
        params: { api_key: process.env.SCRAPER_API_KEY, url, country_code: 'us' },
        timeout: 90000
    });
}

// Lấy salary từ HTML (list page hoặc detail page)
function parseSalary($, root) {
    const node = root ? $(root) : $('body');

    // Các selector phổ biến trên Indeed US
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

    // Regex fallback — tìm pattern $X - $Y a year / an hour
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

// ==================== SCRAPER ====================

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

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

                cards.push({ title, company, salary, loc, link, quick });
            });

            // Fetch detail page để bổ sung salary còn thiếu
            const jobs = [];
            for (const c of cards) {
                let salary = c.salary;
                if (!salary && FETCH_DETAIL && c.link !== 'N/A') {
                    salary = await fetchDetailSalary(c.link);
                }
                jobs.push({
                    Title:          c.title,
                    Company:        c.company,
                    Salary:         salary || 'Not listed',
                    Location:       c.loc,
                    'Apply Method': c.quick ? 'Indeed Quick Apply' : 'Company Website',
                    Link:           c.link,
                    Keyword:        kw,
                    Region:         location
                });
            }

            console.log(`  ✅ [${location}] "${kw}" → ${jobs.length} jobs`);
            return jobs;

        } catch (err) {
            console.warn(`  ⚠️ Lần ${attempt} [${location}] "${kw}" — ${err.response?.status ?? err.message}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 5000));
        }
    }
    return [];
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
                    { title: "Status:",  value: "✅ Sẵn sàng" }
                ]}
            ],
            actions: [{ type: "Action.OpenUrl", title: "📥 Tải Excel", url: fileLink }],
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
    console.log(`📋 ${KEYWORDS.length} keywords | Max ${MAX_PER_KW} jobs/keyword | Fetch detail: ${FETCH_DETAIL}\n`);

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

    const fileName = `Indeed_US_CA_${new Date().toISOString().slice(0,10)}.xlsx`;
    const ws = XLSX.utils.json_to_sheet(allJobs);
    ws['!cols'] = Object.keys(allJobs[0]).map(k => ({
        wch: Math.min(60, Math.max(k.length + 2, ...allJobs.map(r => String(r[k]||'').length)))
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jobs");
    XLSX.writeFile(wb, fileName);
    console.log(`📊 Lưu → ${fileName}`);

    const fileLink = await uploadToCatbox(fileName);
    await Promise.all([
        sendTelegramAlert(`✅ <b>Indeed US / California</b>\n<b>${allJobs.length} jobs</b>\n📎 <a href="${fileLink}">Tải Excel</a>`),
        sendTelegramFile(fileName),
        sendToTeams(allJobs.length, fileLink)
    ]);
    console.log("🏁 Hoàn tất!");
}

runScraper();