#!/bin/bash

#=================================================
# COMMON VARIABLES AND CUSTOM HELPERS
#=================================================

# The nginx includes the location file refers to. They are not *.conf, so the
# domain's server block does not include them a second time on its own.
proxy_inc="/etc/nginx/conf.d/$domain.d/$app.proxy.inc"
shell_headers_inc="/etc/nginx/conf.d/$domain.d/$app.shell-headers.inc"

# Write (or refresh) the nginx includes, then the location file that needs them.
# nginx -t runs inside ynh_config_add_nginx, so the includes have to exist first.
lollywork_add_nginx() {
    ynh_config_add --template="proxy.inc" --destination="$proxy_inc"
    lollywork_add_shell_headers
    ynh_config_add_nginx
}

# The shell header set mirrors the open-source package's security-headers.inc, whose
# connect-src carries __LOLLY_CSP_MODELS_HOST__: lolli.li while the models come from
# there, empty when a server keeps its own. This package always uses lolli.li, so the
# policy it serves is unchanged.
lollywork_add_shell_headers() {
    # shellcheck disable=SC2034 # read by ynh_config_add as __LOLLY_CSP_MODELS_HOST__
    local lolly_csp_models_host=" https://lolli.li"
    ynh_config_add --template="shell-headers.inc" --destination="$shell_headers_inc"
}

# The Nextcloud app on this YunoHost, if there is one: prints its address as an https
# URL (domain and path, no trailing slash), or nothing. `yunohost app list` reports
# each installed app's id and its domain_path; a second instance is nextcloud__2.
lollywork_detect_nextcloud() {
    local domain_path
    domain_path=$(yunohost app list --output-as json 2>/dev/null \
        | jq -r '[.apps[]? | select(.id | test("^nextcloud(__[0-9]+)?$")) | .domain_path][0] // empty' 2>/dev/null) || return 0
    [[ "$domain_path" =~ ^[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] || return 0
    printf 'https://%s' "${domain_path%/}"
}

# Install and upgrade: give the Nextcloud settings their defaults, and when a
# Nextcloud is on this server, prefill its address. Nothing is switched on here: the
# connection needs an app password only the admin can create, pasted in the config
# panel.
lollywork_nextcloud_defaults() {
    ynh_app_setting_set_default --key=nextcloud_enabled --value="false"
    ynh_app_setting_set_default --key=nextcloud_username --value=""
    ynh_app_setting_set_default --key=nextcloud_app_password --value=""
    ynh_app_setting_set_default --key=nextcloud_catalog_folder --value="Lolly brand"
    ynh_app_setting_set_default --key=nextcloud_catalog_groups --value="*"
    ynh_app_setting_set_default --key=nextcloud_delivery_folder --value="Lolly delivery"
    ynh_app_setting_set_default --key=nextcloud_delivery_groups --value="admins"
    if [ -z "${nextcloud_url:-}" ]; then
        local detected
        detected=$(lollywork_detect_nextcloud)
        if [ -n "$detected" ]; then
            nextcloud_url="$detected"
            ynh_print_info "Found Nextcloud at $detected. Connect it under Configuration > Nextcloud."
        else
            nextcloud_url=""
        fi
        ynh_app_setting_set --key=nextcloud_url --value="$nextcloud_url"
    fi
}

# A space-separated group list ("*" or names) as a JSON value: "*" or an array.
lollywork_groups_json() {
    if [[ "$1" == "*" ]]; then printf '"*"'; else jq -cn --arg g "$1" '$g | split(" ") | map(select(length > 0))'; fi
}

# Whether the Nextcloud settings form a complete, valid connection. Prints the first
# problem and fails otherwise, so the config panel can show it.
lollywork_nextcloud_check() {
    local origin_pattern='^https://([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$'
    local folder_pattern='^[A-Za-z0-9 ._-]+(/[A-Za-z0-9 ._-]+)*$' groups_pattern='^(\*|[a-z0-9_-]+( [a-z0-9_-]+)*)$'
    [[ "${nextcloud_url:-}" =~ $origin_pattern ]] || { echo "Enter the Nextcloud address as https://host, optionally with a path."; return 1; }
    [[ "${nextcloud_username:-}" =~ ^[A-Za-z0-9._@-]{1,128}$ ]] || { echo "Enter the Nextcloud login name (letters, digits and . _ @ -)."; return 1; }
    [[ "${nextcloud_app_password:-}" =~ ^[A-Za-z0-9._~=-]{8,255}$ ]] || { echo "Paste an app password from Nextcloud Settings > Security (letters, digits and - . _ ~ =)."; return 1; }
    [[ "${nextcloud_catalog_folder:-}" =~ $folder_pattern && "$nextcloud_catalog_folder" != *..* ]] || { echo "Name the Nextcloud folder to read brand files from."; return 1; }
    [[ -z "${nextcloud_delivery_folder:-}" || ( "$nextcloud_delivery_folder" =~ $folder_pattern && "$nextcloud_delivery_folder" != *..* ) ]] || { echo "The delivery folder must be a plain Nextcloud folder path, or empty for no delivery."; return 1; }
    [[ "${nextcloud_catalog_groups:-*}" =~ $groups_pattern ]] || { echo "Catalog groups: * or YunoHost group names separated by spaces."; return 1; }
    [[ "${nextcloud_delivery_groups:-admins}" =~ $groups_pattern ]] || { echo "Delivery groups: * or YunoHost group names separated by spaces."; return 1; }
}

# Compute the instance.json fragments and the credential for the Nextcloud
# connection. Disabled or incomplete settings give empty lists and an empty
# credential, so an upgrade never fails on a half-filled panel.
lollywork_nextcloud_vars() {
    nextcloud_providers='[]'
    nextcloud_destinations='[]'
    nextcloud_private_origins='[]'
    nextcloud_credential=''
    [[ "${nextcloud_enabled:-false}" == "true" ]] || return 0
    if ! lollywork_nextcloud_check >/dev/null; then
        ynh_print_warn "The Nextcloud connection is switched on but incomplete, so it is left out. Fix it under Configuration > Nextcloud."
        return 0
    fi
    local base="${nextcloud_url%/}" origin login_path folder_path
    origin=$(printf '%s' "$base" | sed -E 's#^(https://[^/]+).*$#\1#')
    nextcloud_credential="$nextcloud_username:$nextcloud_app_password"
    nextcloud_private_origins=$(jq -cn --arg o "$origin" '[$o]')
    nextcloud_providers=$(jq -cn --arg base "$base" --arg user "$nextcloud_username" --arg root "$nextcloud_catalog_folder" \
        --argjson groups "$(lollywork_groups_json "${nextcloud_catalog_groups:-*}")" \
        '[{id: "nextcloud", kind: "webdav", label: "Nextcloud", credentialRef: "LW_PROVIDER_NEXTCLOUD", enabled: true,
           options: {baseUrl: $base, flavor: "nextcloud", username: $user, root: $root, recursive: true},
           exposure: {groups: $groups}}]')
    if [[ -n "${nextcloud_delivery_folder:-}" ]]; then
        login_path=$(jq -rn --arg v "$nextcloud_username" '$v | @uri')
        folder_path=$(jq -rn --arg v "$nextcloud_delivery_folder" '$v | split("/") | map(@uri) | join("/")')
        nextcloud_destinations=$(jq -cn --arg url "$base/remote.php/dav/files/$login_path/$folder_path" \
            --argjson groups "$(lollywork_groups_json "${nextcloud_delivery_groups:-admins}")" \
            '[{id: "nextcloud", kind: "webdav", label: "Nextcloud", credentialRef: "LW_DESTINATION_NEXTCLOUD", enabled: true,
               groups: $groups, formats: ["png", "jpg", "webp", "svg", "pdf", "mp4"], options: {url: $url}}]')
    fi
}

# Write (or refresh) the two files the server reads: its configuration and its
# environment. Both carry secrets (the proxy secret, the database password), so
# they are 600 $app:$app, which is what ynh_config_add gives files in $install_dir.
lollywork_add_config() {
    # The publisher's public catalogue key, pinned in this package. It verifies the
    # signed catalogue of the seeded pack before the server re-signs it per member.
    catalog_public_key=$(tr -d '\n' < "$YNH_APP_BASEDIR/conf/catalog-public-key.json")
    lollywork_nextcloud_vars
    ynh_config_add --template="instance.json" --destination="$install_dir/instance.json"
    ynh_config_add --template=".env" --destination="$install_dir/.env"
}

# A new catalogue signing key for this installation: ECDSA P-256, as a private JWK
# on one line (the server takes a PKCS#8 PEM or a JWK; .env holds one line). The
# server signs each member's catalogue with it and publishes the public half at
# /api/v1/catalog/public-key, which the web app accepts from the origin serving it.
# Without it the catalogue signature route answers 404 and the app lists no tools.
lollywork_new_catalog_key() {
    ynh_exec_as_app node -e 'process.stdout.write(JSON.stringify(require("crypto").generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" })))'
}

# The signed catalogue sequence of the shell this package unpacked. The server
# publishes at no lower a generation, so a browser that has seen one catalogue
# keeps accepting the next.
lollywork_shell_catalog_seq() {
    ynh_exec_as_app node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).seq; if (!Number.isSafeInteger(s) || s < 1) throw new Error("the shell catalogue has no signed sequence"); process.stdout.write(String(s))' "$install_dir/shell/catalog/tools/index.sig.json"
}

# Install the server's runtime dependencies. The tarball ships no node_modules;
# sharp and resvg fetch prebuilt binaries for this architecture.
lollywork_npm_install() {
    pushd "$install_dir" >/dev/null
    ynh_hide_warnings ynh_exec_as_app npm exec --yes --package=pnpm@11.26.0 -- pnpm install --frozen-lockfile --prod
    popd >/dev/null
}

# The initial instance pack is the web shell's own tool set and catalog (the build
# carries the full community tool set with the neutral lolly-start brand). Copy it
# into data_dir once, so the admin can replace it with their own brand pack without
# an upgrade putting the default back.
lollywork_seed_pack() {
    if [ ! -f "$data_dir/pack/catalog/tools/index.json" ]; then
        mkdir -p "$data_dir/pack"
        cp -a "$install_dir/shell/tools" "$data_dir/pack/tools"
        cp -a "$install_dir/shell/catalog" "$data_dir/pack/catalog"
        chown -R "$app:$app" "$data_dir/pack"
    fi
}

# The role permissions have no URL, so nothing else creates their first holder:
# the chosen first owner gets `owner`. Idempotent (a re-add is ignored).
lollywork_grant_first_owner() {
    if ! ynh_permission_has_user --permission="owner" --user="$admin"; then
        ynh_permission_update --permission="owner" --add="$admin"
    fi
}

# What `yunohost service add` registers, in one place so install, upgrade and
# restore describe the service identically.
lollywork_register_service() {
    yunohost service add "$app" --description="Lolly Work: governed Lolly control plane" --log="/var/log/$app/$app.log"
}

# The server logs one "<name> on :<port>" line once it has migrated and bound.
lollywork_wait_started() {
    ynh_systemctl --service="$app" --action="start" --wait_until="on :" --log_path="/var/log/$app/$app.log" --timeout=120
}
