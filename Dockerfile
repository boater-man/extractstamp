# extractstamp — 印章提取（离线自托管版）
# 纯静态站点：nginx 托管，图像处理全部在浏览器本地完成，运行时零外部依赖。

FROM nginx:1.27-alpine

RUN rm -rf /usr/share/nginx/html/*
COPY public/ /usr/share/nginx/html/

RUN printf '%s\n' \
    'server {' \
    '    listen 80;' \
    '    server_name _;' \
    '    root /usr/share/nginx/html;' \
    '    index index.html;' \
    '' \
    '    location = / { add_header Cache-Control "no-cache"; }' \
    '    location = /index.html { add_header Cache-Control "no-cache"; }' \
    '' \
    '    location ~* \.(js|css)$ { add_header Cache-Control "public, max-age=3600"; }' \
    '' \
    '    location / { try_files $uri $uri/ =404; }' \
    '' \
    '    gzip on;' \
    '    gzip_types text/html text/css application/javascript image/svg+xml;' \
    '    gzip_min_length 1024;' \
    '}' \
    > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1
