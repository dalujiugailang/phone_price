#!/bin/zsh
set -euo pipefail

cloud_import_url="${CLOUD_IMPORT_URL:-https://www.gtmdudu.xyz/api/daily-price/import-excel}"
daily_price_dir="${DAILY_PRICE_DIR:-/Users/dudu/Desktop/trae/重点日常项目/【daily price】}"
token_path="${DAILY_PRICE_TOKEN_PATH:-${daily_price_dir}/data/api_token.txt}"
raw_dir="${DAILY_PRICE_RAW_DIR:-${daily_price_dir}/data/raw}"

if [[ ! -f "$token_path" ]]; then
  echo "token file not found: $token_path" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  excel_path="$1"
else
  latest_files=("${raw_dir}"/**/*.xlsx(N.om[1]))
  if [[ ${#latest_files[@]} -eq 0 ]]; then
    echo "no xlsx file found under: $raw_dir" >&2
    exit 1
  fi
  excel_path="${latest_files[1]}"
fi

if [[ ! -f "$excel_path" ]]; then
  echo "excel file not found: $excel_path" >&2
  exit 1
fi

token="$(tr -d '\r\n' < "$token_path")"

curl -fS -X POST "$cloud_import_url" \
  -H "Authorization: Bearer ${token}" \
  -F "file=@${excel_path}"

echo
echo "uploaded: $excel_path"
