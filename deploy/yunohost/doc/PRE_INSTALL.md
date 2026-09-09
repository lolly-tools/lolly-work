Lolly Work needs a **whole domain** (for example `work.example.org`): the console, the API and the web app all resolve from the domain root.

The install runs `pnpm install --frozen-lockfile` against the npm registry to fetch the server's runtime dependencies (about 300 MB), and downloads a prebuilt Lolly web app (a few hundred MB). Allow a few minutes on a small machine. The on-device machine-learning models the tools use are fetched by the browser on first use from `https://lolli.li`, the project's release host, not by the server.

The user you pick as **first owner** gets the owner role. Everything about roles afterwards is in **Users › Groups and permissions**: the app has `owner`, `admin`, `approver` and `author` permissions, and YunoHost admins start as admins.
