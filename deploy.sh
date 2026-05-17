#!/bin/bash
# deploy.sh — chạy trên VPS để build và khởi động lại app
set -e

DOMAIN="duytrinhstudio.io.vn"
EMAIL="hctdiy07@gmail.com"
CERT_SRC="/etc/letsencrypt"
CERT_DEST="./data/certbot/conf"

# ── Kiểm tra Docker ────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "==> Docker chưa được cài. Đang cài Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "==> Docker đã cài xong."
fi

echo "==> Pull code mới nhất..."
git pull

echo "==> Chuẩn bị thư mục data..."
mkdir -p data/configs data/presets data/uploads
mkdir -p data/certbot/conf data/certbot/www
mkdir -p nginx/conf.d

# Tạo users.json mặc định nếu chưa có
if [ ! -f data/users.json ]; then
  echo '{"duytrinh":{"passwordHash":"425290f9bfb69b3059f2e4f1baf5ab7725dd2360467508e203dc50318e66d653","role":"admin"}}' > data/users.json
  echo "==> Đã tạo users.json với tài khoản admin mặc định (duytrinh / duytrinh@)"
fi

# ── Build app ─────────────────────────────────────────────────────────────
echo "==> Build Docker image..."
docker compose build

# ── Lấy SSL cert nếu chưa có ──────────────────────────────────────────────
if [ ! -f "$CERT_DEST/live/$DOMAIN/fullchain.pem" ]; then
  echo "==> Chưa có SSL cert. Đang lấy từ Let's Encrypt..."

  # Đảm bảo không có gì đang chiếm port 80
  docker compose down --remove-orphans 2>/dev/null || true

  # Cài certbot trên host nếu chưa có
  if ! command -v certbot &>/dev/null; then
    echo "==> Cài certbot..."
    apt update -qq && apt install -y certbot
  fi

  # Lấy cert bằng standalone (certbot tự listen port 80)
  certbot certonly --standalone \
    --email "$EMAIL" --agree-tos --no-eff-email \
    -d "$DOMAIN"

  # Copy cert vào thư mục data để Docker volume mount được
  cp -rL "$CERT_SRC/live"    "$CERT_DEST/"
  cp -rL "$CERT_SRC/archive" "$CERT_DEST/"
  echo "==> SSL cert đã lấy xong."
fi

# ── Viết nginx config HTTPS ───────────────────────────────────────────────
cat > nginx/conf.d/app.conf << EOF
server {
    listen 80 default_server;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    location / {
        proxy_pass          http://app:3000;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade \$http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_set_header    Host \$host;
        proxy_set_header    X-Real-IP \$remote_addr;
        proxy_set_header    X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto \$scheme;
        client_max_body_size 20m;
    }
}
EOF

# ── Khởi động tất cả container ────────────────────────────────────────────
echo "==> Khởi động lại tất cả container..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d

echo ""
echo "==> Xong! App đang chạy tại https://$DOMAIN"
echo ""
docker compose ps
