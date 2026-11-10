# Shared by every location in nginx.conf.
proxy_pass http://127.0.0.1:__PORT__;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
# Live collaboration rides a WebSocket on the same server.
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
# Proves to the server that the request came through this nginx (file mode 640).
proxy_set_header X-Lw-Proxy-Auth "__PROXY_SECRET__";
# Renders and deliveries can take a while; collab sockets stay open.
proxy_read_timeout 300s;
proxy_send_timeout 300s;
# Brand assets, fonts and uploaded files.
client_max_body_size 256M;
proxy_request_buffering off;
