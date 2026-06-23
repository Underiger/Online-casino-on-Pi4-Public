# security-headers.inc — 共用安全標頭片段
#
# 不可命名為 *.conf：nginx.conf 以 `include /etc/nginx/conf.d/*.conf;` 在 http
# context 載入該目錄，若用 .conf 副檔名會被自動載入第二次。本檔案改由
# site.conf 在需要的 server/location context 明確 include。
#
# 為何需要明確 include 而非只在外層 server 區塊宣告一次：
# nginx 的 add_header 繼承規則是「子 context 若自己宣告了任何 add_header，
# 就不再繼承上層的 add_header」。/admin 與 / 底下的靜態資源 location 各自宣告了
# Cache-Control，因此會遺失外層 server 區塊的安全標頭，必須在那些 location 內
# 重新 include 本檔案才能補回。

add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options    nosniff                                always;
add_header X-Frame-Options           SAMEORIGIN                             always;
add_header X-XSS-Protection          "1; mode=block"                        always;
add_header Referrer-Policy           "strict-origin-when-cross-origin"      always;
add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self';" always;
