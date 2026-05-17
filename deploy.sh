#!/bin/bash
# deploy.sh — chạy trên VPS để build và khởi động lại app
set -e

# Kiểm tra Docker
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

# Tạo users.json mặc định nếu chưa có
if [ ! -f data/users.json ]; then
  echo '{"duytrinh":{"passwordHash":"425290f9bfb69b3059f2e4f1baf5ab7725dd2360467508e203dc50318e66d653","role":"admin"}}' > data/users.json
  echo "==> Đã tạo users.json với tài khoản admin mặc định (duytrinh / duytrinh@)"
fi

echo "==> Build Docker image..."
docker compose build

echo "==> Khởi động lại container..."
docker compose down --remove-orphans
docker compose up -d

echo "==> Xong! App đang chạy tại port 3000"
echo ""
docker compose ps
