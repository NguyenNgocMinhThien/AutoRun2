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

const RADIUS        = 50;
const FROMAGE       = 7;
const MAX_PER_KW    = 8;   // ← Giới hạn jobs mỗi keyword (tổng 3 vùng)
// =====================================================

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
        throw new Error("Invalid: " + link);
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

// ==================== PARSE SALARY ====================

function extractSalary($, el) {
    // Thử nhiều selector Indeed US 2024-2025
    const selectors = [
        '[data-testid="attribute_snippet_testid"]',
        '[data-testid="salary-snippet"]',
        '.salary-snippet-container',
        '.estimated-salary-container',
        '[class*="salary-snippet"]',
        '[class*="salaryText"]',
        '.metadata-salary-container',
        '[data-testid*="salary"]',
        '.salary-section',
        // Fallback: tìm bất kỳ text chứa $
        '.jobMetaDataGroup'
    ];

    for (const sel of selectors) {
        const text = $(el).find(sel).first().text().trim();
        if (text && text.includes('$')) {
            return text
                .replace(/Full-time|Permanent|Contract|Part-time/gi, '')
                .replace(/\+\d+/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }
    }

    // Last resort: scan toàn bộ text trong card tìm pattern $xxx,xxx
    const fullText = $(el).text();
    const match = fullText.match(/\$[\d,]+(?:\s*-\s*\$[\d,]+)?(?:\s*(?:a year|an hour|\/hr|\/year|per year|per hour))?/i);
    if (match) return match[0].trim();

    return '';
}

// ==================== SCRAPER ====================

async function scrapeKeywordLocation(kw, location) {
    const maxAttempts = 3;
    const q = encodeURIComponent(kw);
    const l = encodeURIComponent(location.param);
    const targetUrl = `https://www.indeed.com/jobs?q=${q}&l=${l}&radius=${RADIUS}&fromage=${FROMAGE}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
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

            $('.job_seen_beacon').each((i, el) => {
                // Dừng khi đủ số lượng
                if (found.length >= MAX_PER_KW) return false;

                const titleEl = $(el).find('h2.jobTitle span[title], h2.jobTitle a span, a.jcs-JobTitle span');
                const title   = titleEl.first().text().trim()
                             || $(el).find('h2.jobTitle').text().trim();
                if (!title) return;

                const linkEl       = $(el).find('h2.jobTitle a, a.jcs-JobTitle');
                const relativeLink = linkEl.attr('href') || '';

                const salary = extractSalary($, el);

                const jobLocation =
                    $(el).find('[data-testid="text-location"]').text().trim() ||
                    $(el).find('.companyLocation').text().trim()              ||
                    location.label;

                const company =
                    $(el).find('[data-testid="company-name"]').text().trim() ||
                    $(el).find('.companyName').text().trim() || 'N/A';

                const isQuickApply = $(el).find('[data-testid="indeedApplyButton"], .iaIcon').length > 0;

                found.push({
                    Title:          title,
                    Company:        company,
                    Salary:         salary || 'Not listed',
                    Location:       jobLocation,
                    'Apply Method': isQuickApply ? 'Indeed Quick Apply' : 'Company Website',
                    Link:           relativeLink ? `https://www.indeed.com${relativeLink}` : 'N/A',
                    Keyword:        kw,
                    Region:         location.label
                });
            });

            console.log(`  ✅ [${location.label}] "${kw}" → ${found.length} jobs`);
            return found;

        } catch (err) {
            const status = err.response?.status ?? 'N/A';
            console.warn(`  ⚠️ Lần ${attempt} — HTTP ${status}: ${err.message}`);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 6000));
        }
    }
    return [];
}

// ==================== MAIN ====================

async function runScraper() {
    console.log("🚀 Indeed US Scraper — California");
    console.log(`📋 ${KEYWORDS.length} keywords × ${LOCATIONS.length} vùng | Max ${MAX_PER_KW} jobs/keyword\n`);

    if (!process.env.SCRAPER_API_KEY) {
        console.error("❌ Thiếu SCRAPER_API_KEY!");
        process.exit(1);
    }

    let allJobs = [];

    for (const kw of KEYWORDS) {
        let kwJobs = [];

        for (const loc of LOCATIONS) {
            // Chỉ cần đủ MAX_PER_KW thì bỏ qua các vùng còn lại
            if (kwJobs.length >= MAX_PER_KW) break;

            const jobs = await scrapeKeywordLocation(kw, loc);
            kwJobs.push(...jobs);
            await new Promise(r => setTimeout(r, 2000));
        }

        // Giới hạn cứng theo keyword
        kwJobs = kwJobs.slice(0, MAX_PER_KW);
        console.log(`  → Tổng "${kw}": ${kwJobs.length} jobs\n`);
        allJobs.push(...kwJobs);
    }

    allJobs = dedup(allJobs);
    console.log(`📦 Tổng sau dedup: ${allJobs.length} jobs`);

    if (allJobs.length === 0) {
        console.log("❌ Không tìm thấy job nào.");
        await sendTelegramAlert("❌ Indeed US/CA: Không có job nào.");
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
            `<b>${allJobs.length} jobs</b>\n` +
            `📎 <a href="${fileLink}">Tải Excel</a>`
        ),
        sendTelegramFile(fileName),
        sendToTeams(allJobs.length, fileLink)
    ]);

    console.log("🏁 Hoàn tất!");
}

runScraper();