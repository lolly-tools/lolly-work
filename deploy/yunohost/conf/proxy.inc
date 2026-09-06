# Everything a location needs to hand a request to the Lolly Work server. One file
# so the several locations in nginx.conf cannot disagree; it is not a *.conf, so
# the domain's server block does not include it on its own.
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
# The shared secret the server requires beside the SSOwat identity headers, so
# only requests that came through this nginx can sign a member in. The file is
# root-readable only (ynh_config_add writes 640).
proxy_set_header X-Lw-Proxy-Auth "__PROXY_SECRET__";
# Renders and deliveries can take a while; collab sockets stay open.
proxy_read_timeout 300s;
proxy_send_timeout 300s;
# Brand assets, fonts and uploaded files.
client_max_body_size 256M;
proxy_request_buffering off;
