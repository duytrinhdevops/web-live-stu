#!/bin/bash
# deploy.sh — chạy trên VPS để build và khởi động lại app
set -e

DOMAIN="duytrinhstudio.io.vn"
EMAIL="hctdiy07@gmail.com"
CERT_DIR="./data/certbot/conf/live/$DOMAIN"

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

# ── Hàm viết nginx config ──────────────────────────────────────────────────

write_http_only_conf() {
  cat > nginx/conf.d/app.conf << EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'Initializing SSL...'; add_header Content-Type text/plain; }
}
EOF
}

write_full_conf() {
  cat > nginx/conf.d/app.conf << EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
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
}

# ── Build app image ────────────────────────────────────────────────────────
echo "==> Build Docker image..."
docker compose build

# ── Lấy SSL cert lần đầu nếu chưa có ─────────────────────────────────────
if [ ! -d "$CERT_DIR" ]; then
  echo "==> Lần đầu chạy: lấy SSL certificate cho $DOMAIN..."
  write_http_only_conf
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose up -d nginx
  echo "==> Đợi nginx sẵn sàng..."
  sleep 5
  docker compose run --rm certbot certonly \
    --webroot --webroot-path=/var/www/certbot \
    --email "$EMAIL" --agree-tos --no-eff-email \
    -d "$DOMAIN"
  echo "==> SSL cert đã lấy thành công!"
fi

# ── Viết config đầy đủ và khởi động ──────────────────────────────────────
write_full_conf

echo "==> Khởi động lại tất cả container..."
docker compose down --remove-orphans
docker compose up -d

echo ""
echo "==> Xong! App đang chạy tại https://$DOMAIN"
echo ""
docker compose ps
