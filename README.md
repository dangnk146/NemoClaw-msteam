# NemoClaw — MS Teams Edition

Fork của [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) với MS Teams bot support đầy đủ.

Chạy OpenClaw agent bên trong OpenShell sandbox, nhận và trả lời tin nhắn từ Microsoft Teams qua host-side bridge.

---

## Yêu cầu

- Ubuntu 22.04+
- Docker
- Node.js >= 22.16.0
- `openshell` CLI
- Azure Bot Registration (App ID + App Password)
- NVIDIA API Key (hoặc OpenAI API Key)

---

## Cài đặt

```bash
curl -fsSL https://raw.githubusercontent.com/dangnk146/NemoClaw-msteam/main/install.sh | bash
```

Sau khi cài xong, chạy onboarding:

```bash
nemoclaw onboard
```

---

## Cấu hình MS Teams

### Bước 1 — Tạo Azure Bot

1. Vào [Azure Portal](https://portal.azure.com) → **Azure Bot** → Create
2. Chọn **Multi Tenant** hoặc **Single Tenant**
3. Lưu lại:
   - **App ID** (Microsoft App ID)
   - **App Password** (Client Secret — tạo trong Certificates & secrets)
   - **Tenant ID**

### Bước 2 — Cấu hình NemoClaw

```bash
nemoclaw setup-msteams
```

Wizard sẽ hỏi App ID, App Password, Tenant ID và các policy.

Hoặc set env vars thủ công:

```bash
export MSTEAMS_APP_ID=<your-app-id>
export MSTEAMS_APP_PASSWORD=<your-app-password>
export MSTEAMS_TENANT_ID=<your-tenant-id>
export MSTEAMS_WEBHOOK_PORT=3978
export MSTEAMS_WEBHOOK_PATH=/api/messages
export SANDBOX_NAME=kiloba        # tên sandbox của bạn
export NVIDIA_API_KEY=<your-key>  # hoặc OPENAI_API_KEY
```

### Bước 3 — Start bridge

```bash
nemoclaw start
```

Bridge sẽ lắng nghe tại `http://0.0.0.0:3978/api/messages`.

Kiểm tra trạng thái:

```bash
nemoclaw status
```

### Bước 4 — Expose port ra internet

Teams cần gọi được vào webhook endpoint. Dùng cloudflared (tự động) hoặc ngrok:

```bash
# cloudflared được start tự động bởi nemoclaw start nếu đã cài
# Hoặc dùng ngrok thủ công:
ngrok http 3978
```

Lấy URL public (ví dụ `https://abc123.ngrok.io`).

### Bước 5 — Set Messaging Endpoint trên Azure

1. Vào Azure Portal → Azure Bot của bạn → **Configuration**
2. Set **Messaging endpoint**: `https://<your-public-url>/api/messages`
3. Save

### Bước 6 — Thêm bot vào Teams

1. Vào Azure Portal → Azure Bot → **Channels** → Add **Microsoft Teams**
2. Mở Teams → Apps → tìm bot theo App ID
3. Gửi tin nhắn cho bot

---

## Kiến trúc

```
Microsoft Teams
      │
      │  HTTPS webhook POST
      ▼
[msteams-bridge.js]  ← chạy trên HOST
      │
      │  SSH → openshell sandbox connect
      ▼
[OpenShell Sandbox]
      │
      └─ OpenClaw agent (inference → NVIDIA/OpenAI)
      │
      └─ Reply qua Bot Framework REST API
            │
            ▼
      Microsoft Teams
```

Bridge chạy **trên host** (không phải trong sandbox) — giống pattern của Telegram bridge. Không cần outbound connection từ sandbox cho Teams messaging.

---

## Quản lý sandbox

```bash
# Xem danh sách sandbox
nemoclaw list

# Kết nối vào sandbox
nemoclaw kiloba connect

# Xem logs
nemoclaw kiloba logs --follow

# Xem status
nemoclaw kiloba status

# Xóa sandbox
nemoclaw kiloba destroy
```

---

## Services

```bash
nemoclaw start    # start tất cả services (Teams bridge, Telegram bridge, cloudflared)
nemoclaw stop     # stop tất cả
nemoclaw status   # xem trạng thái
```

Log của bridge:

```bash
tail -f /tmp/nemoclaw-services-<sandbox-name>/msteams-bridge.log
```

---

## Troubleshooting

**Bot không nhận được tin nhắn từ Teams**
- Kiểm tra Messaging endpoint đã set đúng chưa trên Azure Portal
- Kiểm tra port 3978 có được expose ra internet không: `curl https://<your-url>/api/messages`
- Xem log bridge: `tail -f /tmp/nemoclaw-services-*/msteams-bridge.log`

**Bot nhận được tin nhắn nhưng không reply**
- Kiểm tra sandbox đang chạy: `nemoclaw status`
- Kiểm tra NVIDIA_API_KEY đã set chưa
- Xem log sandbox: `nemoclaw kiloba logs --follow`

**Lỗi EACCES khi openclaw update**
- Đã được fix trong version này — `NPM_CONFIG_PREFIX=/sandbox/.npm-global`
- Nếu vẫn lỗi: `npm config set prefix /sandbox/.npm-global` trong sandbox

**Rebuild sandbox sau khi thay đổi config**

```bash
nemoclaw onboard
```

---

## License

Apache 2.0 — xem [LICENSE](LICENSE)
