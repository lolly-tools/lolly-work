# Compose

`docker-compose.yml` is the single-server Lolly Work stack: the server and PostgreSQL. The install
steps are in `docs/install.md`, section 5.

## Optional Garage blob store

By default the server keeps catalog bytes, shell assets and other blobs in PostgreSQL. A media-heavy
instance can keep them in an S3-compatible store instead (`blobs.driver: "s3"`). The `garage` profile
adds [Garage](https://garagehq.deuxfleurs.fr/), a small self-hosted store, to the same stack. It is
not started unless you ask for it, and it publishes no port: only the server container reaches it.

1. Generate a secret once and keep it in `deploy/compose/.env`:

   ```sh
   echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)" >> .env
   ```

2. Start the store, then give the single node a role. The first command prints the node id; use its
   first characters in the second.

   ```sh
   docker compose --profile garage up -d garage
   docker compose exec garage /garage status
   docker compose exec garage /garage layout assign -z dc1 -c 20G <node-id>
   docker compose exec garage /garage layout apply --version 1
   ```

   `-c` is the capacity Garage may use. Pick a figure below the free space on the volume.

3. Create the bucket and a key limited to it:

   ```sh
   docker compose exec garage /garage bucket create lolly-blobs
   docker compose exec garage /garage key create lolly-server
   docker compose exec garage /garage bucket allow --read --write --owner lolly-blobs --key lolly-server
   ```

   The key command prints a key id and a secret. Put them in `.env`:

   ```sh
   LW_BLOBS_S3_CREDENTIAL=<key id>:<secret key>
   ```

4. Point the instance at the store in `instance.json`, then restart the server:

   ```json
   "blobs": {
     "driver": "s3",
     "s3": { "bucket": "lolly-blobs", "region": "garage", "endpoint": "http://garage:3900" }
   }
   ```

   ```sh
   docker compose --profile garage up -d
   ```

Choose the driver before the instance stores blobs. Changing it later does not copy blobs already in PostgreSQL; `docs/operations.md` covers what the database holds.

The connection is plain HTTP on the private Compose network. Do not publish Garage's S3 port
without TLS in front. Back up the `garage-meta` and `garage-data` volumes together; the data volume
alone cannot be read without its metadata. For a store shared with other services, or on another
host, run Garage separately and use its address as `endpoint`.
