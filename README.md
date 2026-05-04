# Indeed Auto Job Scraper (Vancouver)

Công cụ tự động quét việc làm trên **Indeed Canada** theo từ khóa, tập trung khu vực **Vancouver, BC** và gửi báo cáo qua Telegram + Microsoft Teams.

### Tính năng chính
- Quét job theo nhiều từ khóa (Analyst, CFA, Data Science...)
- Lọc job có mức lương từ **$60,000/năm** trở lên
- **Chỉ lấy phần lương sạch sẽ** (ví dụ: `$85,000 - $110,000 a year`)
- Xuất file Excel với các cột: Title, Company, Salary, Location, Apply Method, Link, Keyword
- Tự động upload file lên Litterbox (link tải tạm 24h)
- Gửi thông báo + file qua **Telegram** và **Microsoft Teams**
- Chạy tự động hàng ngày qua GitHub Actions

---

## Cấu trúc thư mục
indeed-auto-scraper/
├── scraper.js                 # File chính (đã tối ưu salary)
├── package.json
├── package-lock.json
├── .github/workflows/
│   └── cron.yml               # GitHub Actions workflow
├── Indeed_Jobs_*.xlsx         # File Excel được tạo (tự động)
└── README.md
text---

## Cách sử dụng

### 1. Clone repository
```bash
git clone <your-repo-url>
cd indeed-auto-scraper
2. Cài đặt dependencies
Bashnpm install
3. Thiết lập biến môi trường (Secrets)
Bạn cần tạo các GitHub Secrets sau:
Secret NameMô tảBắt buộcSCRAPER_API_KEYAPI key của ScraperAPICóTELEGRAM_TOKENToken Bot TelegramCóTELEGRAM_CHAT_IDChat ID nhận thông báoCóTEAMS_WEBHOOK_URLWebhook của Microsoft TeamsKhông
Lưu ý: TEAMS_WEBHOOK_URL là tùy chọn. Nếu không có thì chỉ gửi qua Telegram.
4. Chạy thủ công (test)
Bashnode scraper.js
5. Chạy tự động hàng ngày
Workflow đã được thiết lập chạy lúc 00:00 UTC mỗi ngày (cron: '0 0 * * *').
Bạn có thể chạy thủ công bằng cách vào Actions → Daily Job Scraper → Run workflow.

Tùy chỉnh
Thay đổi từ khóa tìm kiếm
Mở file scraper.js, sửa mảng KEYWORDS:
JavaScriptconst KEYWORDS = [
    "Analyst", 
    "CFA", 
    "Data Science", 
    "FP&A", 
    "Business Intelligence",
    "Financial Analyst"
];
Thay đổi khu vực / bộ lọc lương
Hiện tại đang lọc:

Khu vực: Vancouver, BC (bán kính 25km)
Lương tối thiểu: $60,000

Bạn có thể chỉnh URL trong vòng lặp for:
JavaScriptconst targetUrl = `https://ca.indeed.com/jobs?q=${encodeURIComponent(kw + ' $60,000')}&l=Vancouver%2C+BC&radius=25&fromage=3`;

Output Excel
File Excel sẽ có các cột:

Title
Company
Salary ← Chỉ giữ phần số tiền sạch (không có "Full-time", "Permanent"...)
Location
Apply Method
Link
Keyword


Công nghệ sử dụng

Node.js + ES Modules
Cheerio (parse HTML)
ScraperAPI (bypass anti-bot)
XLSX (xuất Excel)
Litterbox (upload file tạm)
GitHub Actions (chạy tự động)


Lưu ý quan trọng

ScraperAPI có giới hạn request theo gói. Hãy theo dõi usage.
Indeed thường thay đổi giao diện → có thể cần cập nhật selector sau này.
File Excel được upload lên Litterbox chỉ tồn tại 24 giờ.


Hỗ trợ
<<<<<<< HEAD
Nếu gặp lỗi hoặc muốn thêm tính năng (ví dụ: gửi Gmail, lưu vào Google Drive, thêm cột Posted Date...), hãy tạo Issue hoặc liên hệ.
=======
Nếu gặp lỗi hoặc muốn thêm tính năng (ví dụ: gửi Gmail, lưu vào Google Drive, thêm cột Posted Date...), hãy tạo Issue hoặc liên hệ.
>>>>>>> 62dce1bc07d87248fe1baf089f66944f68de847c
