import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
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
    { label: "Los Angeles, CA",   param: "Los Angeles, CA" },
    { label: "San Francisco, CA", param: "San Francisco, CA" },
    { label: "San Jose, CA",      param: "San Jose, CA" }
];

const RADIUS  = 50;
const FROMAGE = 7;
// =====================================================

function salaryQualifies(salaryText) {
    if (!salaryText || !salaryText.includes('$')) return false;
    const cleaned = salaryText.replace(/,/g, '');
    const numbers = [...cleaned.matchAll(/\$?([\d.]+)/g)].map(m => parseFloat(m[1]));
    if (!numbers.length) return false;
    for (const num of numbers) {
        if (/hour|hr/i.test(salaryText)  && num >= 120)    return true;
        if (/year|yr|annual/i.test(salaryText) && num >= 250000) return true;
        if (!/hour|hr|month|week/i.test(salaryText) && num >= 250000) return true;
    }
    return false;
}

function dedup(jobs) {
    const seen = new Set();
    return jobs.filter(j => {
        const key = `${j.Title}|${j.Company}|${j.Location}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ==================== UPLOAD & NOTIFY ====================

async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(filePath));
        const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
            headers: form.getHeaders()
        });
        const link = res.data.trim();
        if (link.includes('https://')) return link;
        throw new Error("Invalid link: " + link);
    } catch (e) {
        console.error("❌ Catbox:", e.message);
        return `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`;
    }
}

async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;
    const card = {
        "type": "AdaptiveCard", "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 JOB MỚI — CALIFORNIA US ($250k+)", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            { "type": "FactSet", "facts": [
                { "title": "Nguồn:",    "value": "Indeed US" },
                { "title": "Khu vực:", "value": "California (LA / SF / SJ)" },
                { "title": "Lương:",   "value": "≥ $250,000/năm" },
                { "title": "Số job:",  "value": `${totalJobs}` },
                { "title": "Status:",  "value": "✅ Sẵn sàng" }
            ]}
        ],
        "actions": [{ "type": "Action.OpenUrl", "title": "📥 Tải Excel", "url": fileLink }],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };
    try {
        await axios.post(webhookUrl, card);
        console.log("✅ [Teams] Gửi thành công!");
    } catch (e) { console.error("❌ [Teams]:", e.message); }
}

async function sendTelegramAlert(message) {
    const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("❌ Telegram:", e.message); }
}

async function sendTelegramFile(filePath) {
    const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
    if (!token || !chatId || !fs.existsSync(filePath)) return;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        console.log("✅ [Telegram] File đã gửi!");
    } catch (e) { console.error("❌ Telegram File:", e.message); }
}

// ==================== SCRAPER ====================

async function scrapeKeywordLocation(kw, location) {
    const maxAttempts = 3;

    // Build URL — encode từng param riêng lẻ
    const q = encodeURIComponent(kw);
    const l = encodeURIComponent(location.param);
    const targetUrl = `https://www.indeed.com/jobs?q=${q}&l=${l}&radius=${RADIUS}&fromage=${FROMAGE}`;

    console.log(`  🔍 [${location.label}] "${kw}"`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // ScraperAPI endpoint đúng: https://api.scraperapi.com/
            // Truyền targetUrl qua params.url — axios sẽ encode lại đúng
            const response = await axios.get('https://api.scraperapi.com/', {
                params: {
                    api_key:      process.env.SCRAPER_API_KEY,
                    url:          targetUrl,
                    country_code: 'us',
                    render:       'false'
                },
                timeout: 90000
            });

            const $ = cheerio.load(response.data);
            const found = [];

            const totalCards = $('.job_seen_beacon').length;
            console.log(`     → ${totalCards} cards trên trang`);

            $('.job_seen_beacon').each((i, el) => {
                const titleEl = $(el).find('h2.jobTitle span[title], h2.jobTitle a, a.jcs-JobTitle');
                const title   = titleEl.first().text().trim();
                if (!title) return;

                const linkEl       = $(el).find('h2.jobTitle a, a.jcs-JobTitle');
                const relativeLink = linkEl.attr('href') || '';

                let salary = $(el).find(
                    '[data-testid="attribute_snippet_testid"], ' +
                    '.salary-snippet-container, ' +
                    '.estimated-salary-container, ' +
                    '[class*="salary-snippet"], ' +
                    '.salary-section'
                ).first().text().replace(/\s+/g, ' ').trim();

                if (salary.includes('$')) {
                    salary = salary.replace(/Full-time|Permanent|Contract/gi, '').replace(/\+\d+/g, '').trim();
                } else {
                    salary = '';
                }

                if (salary && !salaryQualifies(salary)) return;

                const jobLocation = $(el).find('[data-testid="text-location"]').text().trim()
                    || $(el).find('.companyLocation').text().trim()
                    || location.label;

                const company = $(el).find('[data-testid="company-name"]').text().trim() || 'N/A';
                const isQuickApply = $(el).find('[data-testid="indeedApplyButton"], .iaIcon').length > 0;

                found.push({
                    Title:          title,
                    Company:        company,
                    Salary:         salary,
                    Location:       jobLocation,
                    'Apply Method': isQuickApply ? 'Indeed Quick Apply' : 'Company Website',
                    Link:           relativeLink ? `https://www.indeed.com${relativeLink}` : 'N/A',
                    Keyword:        kw,
                    Region:         location.label
                });
            });

            console.log(`  ✅ ${found.length} jobs đạt điều kiện lương`);
            return found;

        } catch (err) {
            const status = err.response?.status ?? 'N/A';
            const body   = JSON.stringify(err.response?.data ?? err.message).slice(0, 300);
            console.warn(`  ⚠️ Lần ${attempt} — HTTP ${status}: ${body}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 6000));
        }
    }

    return [];
}

// ==================== MAIN ====================

async function runScraper() {
    console.log("🚀 Indeed US Scraper — California");
    console.log(`📋 ${KEYWORDS.length} keywords × ${LOCATIONS.length} vùng\n`);

    if (!process.env.SCRAPER_API_KEY) {
        console.error("❌ Thiếu SCRAPER_API_KEY!");
        process.exit(1);
    }

    let allJobs = [];

    for (const kw of KEYWORDS) {
        for (const loc of LOCATIONS) {
            const jobs = await scrapeKeywordLocation(kw, loc);
            allJobs.push(...jobs);
            await new Promise(r => setTimeout(r, 2500));
        }
    }

    allJobs = dedup(allJobs);
    console.log(`\n📦 Tổng sau dedup: ${allJobs.length} jobs`);

    if (allJobs.length === 0) {
        console.log("❌ Không tìm thấy job nào.");
        await sendTelegramAlert("❌ Indeed US/CA: Không có job ≥ $250k/năm.");
        return;
    }

    const fileName = `Indeed_US_CA_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const ws = XLSX.utils.json_to_sheet(allJobs);
    ws['!cols'] = Object.keys(allJobs[0]).map(k => ({
        wch: Math.min(60, Math.max(k.length + 2, ...allJobs.map(r => String(r[k] || '').length)))
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jobs");
    XLSX.writeFile(wb, fileName);
    console.log(`📊 Lưu ${allJobs.length} jobs → ${fileName}`);

    const fileLink = await uploadToCatbox(fileName);

    await Promise.all([
        sendTelegramAlert(
            `✅ <b>Indeed US / California</b>\n` +
            `<b>${allJobs.length} jobs</b> lương ≥ $250k/năm\n` +
            `📎 <a href="${fileLink}">Tải Excel</a>`
        ),
        sendTelegramFile(fileName),
        sendToTeams(allJobs.length, fileLink)
    ]);

    console.log("🏁 Hoàn tất!");
}

runScraper();