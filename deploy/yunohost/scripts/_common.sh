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
    ynh_config_add --template="shell-headers.inc" --destination="$shell_headers_inc"
    ynh_config_add_nginx
}

# Write (or refresh) the two files the server reads: its configuration and its
# environment. Both carry secrets (the proxy secret, the database password), so
# they are 600 $app:$app, which is what ynh_config_add gives files in $install_dir.
lollywork_add_config() {
    # The publisher's public catalogue key, pinned in this package. It verifies the
    # signed catalogue of the seeded pack before the server re-signs it per member.
    catalog_public_key=$(tr -d '\n' < "$YNH_APP_BASEDIR/conf/catalog-public-key.json")
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
