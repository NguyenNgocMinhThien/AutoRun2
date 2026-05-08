import axios from 'axios';
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

const MAX_PER_KW = 8;   // Tổng jobs mỗi keyword (gộp 3 vùng)
const FROMAGE    = 7;   // 7 ngày gần nhất
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
            { "type": "TextBlock", "text": "🚀 JOB MỚI — CALIFORNIA US", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            { "type": "FactSet", "facts": [
                { "title": "Nguồn:",    "value": "Indeed US" },
                { "title": "Khu vực:", "value": "California (LA / SF / SJ)" },
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

// ==================== SCRAPER (Structured Data API) ====================

async function scrapeKeywordLocation(kw, location) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // ScraperAPI Structured Data — trả JSON có đầy đủ salary
            const response = await axios.get('https://api.scraperapi.com/structured/indeed/search', {
                params: {
                    api_key:  process.env.SCRAPER_API_KEY,
                    query:    kw,
                    location: location,
                    country:  'us',
                    page:     1,
                    fromage:  FROMAGE
                },
                timeout: 90000
            });

            const data = response.data;
            // Structured API trả về: { jobs: [...] }
            const rawJobs = data?.jobs || data?.organic_results || data?.results || [];

            if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
                console.log(`  ⚠️ [${location}] "${kw}" — Không có data (attempt ${attempt})`);
                // Thử lại nếu empty
                if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 4000)); continue; }
                return [];
            }

            const found = rawJobs.slice(0, MAX_PER_KW).map(job => {
                // Chuẩn hóa salary từ nhiều field có thể có
                const salary =
                    job.salary          ||
                    job.salary_text     ||
                    job.salary_min && job.salary_max
                        ? `$${job.salary_min?.toLocaleString()} - $${job.salary_max?.toLocaleString()} ${job.salary_type || ''}`
                        : job.pay         ||
                          job.compensation||
                          'Not listed';

                const link = job.link || job.url || job.job_url || '';

                return {
                    Title:          job.title        || job.job_title  || 'N/A',
                    Company:        job.company      || job.company_name|| 'N/A',
                    Salary:         typeof salary === 'string' ? salary.trim() : 'Not listed',
                    Location:       job.location     || job.job_location|| location,
                    'Apply Method': job.apply_options?.[0]?.title || (link.includes('indeed') ? 'Indeed' : 'Company Website'),
                    Link:           link.startsWith('http') ? link : link ? `https://www.indeed.com${link}` : 'N/A',
                    Keyword:        kw,
                    Region:         location,
                    'Date Posted':  job.date         || job.posted_at  || ''
                };
            });

            console.log(`  ✅ [${location}] "${kw}" → ${found.length} jobs`);
            return found;

        } catch (err) {
            const status  = err.response?.status ?? 'N/A';
            const errBody = JSON.stringify(err.response?.data ?? err.message).slice(0, 200);
            console.warn(`  ⚠️ Lần ${attempt} [${location}] "${kw}" — HTTP ${status}: ${errBody}`);

            // Nếu structured API không khả dụng (404/403), fallback sang raw scrape
            if (status === 404 || status === 403) {
                console.log(`  🔄 Fallback sang raw scrape...`);
                return await scrapeRawFallback(kw, location);
            }

            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 6000));
        }
    }
    return [];
}

// ==================== FALLBACK: Raw HTML scrape + fetch job detail ====================

import * as cheerio from 'cheerio';

async function scrapeRawFallback(kw, location) {
    try {
        const q = encodeURIComponent(kw);
        const l = encodeURIComponent(location);
        const targetUrl = `https://www.indeed.com/jobs?q=${q}&l=${l}&radius=50&fromage=${FROMAGE}`;

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
        const jobs = [];

        // Lấy danh sách job cơ bản từ list page
        const cards = [];
        $('.job_seen_beacon').each((i, el) => {
            if (cards.length >= MAX_PER_KW) return false;

            const titleEl      = $(el).find('h2.jobTitle a, a.jcs-JobTitle');
            const title        = titleEl.text().trim() || $(el).find('h2.jobTitle').text().trim();
            const relativeLink = titleEl.attr('href') || '';
            if (!title) return;

            // Thử lấy salary từ list page trước
            let salary = '';
            const salarySelectors = [
                '[data-testid="attribute_snippet_testid"]',
                '[data-testid="salary-snippet"]',
                '.salary-snippet-container',
                '.estimated-salary-container',
                '[class*="salary"]'
            ];
            for (const sel of salarySelectors) {
                const t = $(el).find(sel).first().text().trim();
                if (t && t.includes('$')) { salary = t; break; }
            }
            // Regex fallback
            if (!salary) {
                const m = $(el).text().match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?(?:\s*(?:a year|an hour|\/hr|\/year))?/i);
                if (m) salary = m[0];
            }

            cards.push({
                title,
                company:  $(el).find('[data-testid="company-name"], .companyName').text().trim() || 'N/A',
                location: $(el).find('[data-testid="text-location"], .companyLocation').text().trim() || location,
                salary,
                link:     relativeLink ? `https://www.indeed.com${relativeLink}` : 'N/A',
                isQuick:  $(el).find('[data-testid="indeedApplyButton"], .iaIcon').length > 0
            });
        });

        // Fetch job detail page để lấy salary nếu list page không có
        for (const card of cards) {
            let salary = card.salary;

            if (!salary && card.link !== 'N/A') {
                try {
                    await new Promise(r => setTimeout(r, 1500));
                    const detail = await axios.get('https://api.scraperapi.com/', {
                        params: {
                            api_key:      process.env.SCRAPER_API_KEY,
                            url:          card.link,
                            country_code: 'us'
                        },
                        timeout: 60000
                    });
                    const $d = cheerio.load(detail.data);

                    // Selector trong job detail page
                    const detailSelectors = [
                        '[data-testid="jobsearch-JobMetadataHeader-salaryInfoAndJobType"]',
                        '[data-testid="salary-snippet"]',
                        '.jobsearch-JobMetadataHeader-item',
                        '[class*="salaryInfoAndJobType"]',
                        '.icl-u-xs-mr--xs'
                    ];
                    for (const sel of detailSelectors) {
                        const t = $d(sel).text().replace(/\s+/g, ' ').trim();
                        if (t && t.includes('$')) { salary = t; break; }
                    }
                    // Regex fallback trên detail
                    if (!salary) {
                        const m = $d('body').text().match(/\$[\d,]+\s*[-–]\s*\$[\d,]+\s*a year/i);
                        if (m) salary = m[0];
                    }
                } catch (e) {
                    // Bỏ qua nếu lỗi fetch detail
                }
            }

            jobs.push({
                Title:          card.title,
                Company:        card.company,
                Salary:         salary || 'Not listed',
                Location:       card.location,
                'Apply Method': card.isQuick ? 'Indeed Quick Apply' : 'Company Website',
                Link:           card.link,
                Keyword:        kw,
                Region:         location,
                'Date Posted':  ''
            });
        }

        console.log(`  ✅ [Fallback][${location}] "${kw}" → ${jobs.length} jobs`);
        return jobs;

    } catch (err) {
        console.error(`  ❌ Fallback error: ${err.message}`);
        return [];
    }
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
            if (kwJobs.length >= MAX_PER_KW) break;
            const jobs = await scrapeKeywordLocation(kw, loc);
            kwJobs.push(...jobs);
            await new Promise(r => setTimeout(r, 2000));
        }

        kwJobs = dedup(kwJobs).slice(0, MAX_PER_KW);
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