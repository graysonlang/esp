# HTTPS Development Certificates

This guide describes how to use the `esp` certificate helper with esbuild's HTTPS serve mode for local development.

The helper creates a server certificate under `.esp_dev_certs/` and uses mkcert's configured certificate authority directly. The `.esp_dev_certs/` directory should stay out of git.

## Prerequisite: mkcert

Install `mkcert` before running the certificate helper. On macOS with Homebrew:

```sh
brew install mkcert
```

Verify it is available:

```sh
mkcert -version
```

You do not need to run `mkcert -install` manually for this workflow. The `cert:dev` script creates the certificate files and uses the CA reported by `mkcert -CAROOT`. When a certificate is generated, it also trusts that CA automatically: macOS uses the login keychain, while other platforms use `mkcert -install`.

## Consumer Project Setup

When `@graysonlang/esp` is installed as a dependency, it exposes `esp-generate-dev-cert` as a bin. Add the following scripts to your project's `package.json`, replacing `<project>-dev` with a name specific to your project (e.g. `myapp-dev`):

```json
{
  "cert:dev": "ESP_DEV_CERT_NAME=<project>-dev esp-generate-dev-cert",
  "serve": "node ./scripts/build.mjs --watch --serve",
  "serve:https": "ESP_DEV_CERT_NAME=<project>-dev npm run serve -- --host=0.0.0.0",
  "vscode:debug": "npm run serve -- --vscode",
  "vscode:debug:https": "npm run serve:https -- --vscode"
}
```

By default, generated cert files are written to `.esp_dev_certs/` in the project root. If you regularly run cleanup commands such as `git clean`, you can keep those files somewhere more durable by setting `ESP_DEV_CERTS_DIR` to a directory outside the repository in your user environment, such as `.zshrc`:

```sh
export ESP_DEV_CERTS_DIR="$HOME/.config/esp_dev_certs"
```

The rest of this guide refers to this as `npm run cert:dev`.

## Generate the Certificate

From the project root:

```sh
npm run cert:dev
```

The script creates:

```text
.esp_dev_certs/<project>-dev.pem
.esp_dev_certs/<project>-dev-key.pem
```

If `ESP_DEV_CERTS_DIR` is set, the files are created in that directory instead.

The script automatically trusts the mkcert CA whenever it generates a new certificate. If the cert and key already exist, the script reuses them. To regenerate them:

```sh
ESP_DEV_CERT_FORCE=1 npm run cert:dev
```

Regenerate when your LAN IP changes and the existing certificate does not include the address you need to open from another device.

## Trust the CA

To retrust the mkcert CA without regenerating the certificate:

```sh
npm run cert:dev -- --trust
```

On macOS, the helper adds the CA from `mkcert -CAROOT` to your login keychain with `security add-trusted-cert`. On other platforms, it runs `mkcert -install`.

To generate a certificate without changing local trust:

```sh
npm run cert:dev -- --skip-trust
```

After changing trust settings, restart any already-open browser debug window so the browser rereads certificate trust.

## Serve With HTTPS

Pass the same `ESP_DEV_CERT_NAME` to the esbuild runner. The runner recomposes the certificate and key paths from `ESP_DEV_CERTS_DIR` and `ESP_DEV_CERT_NAME`, matching the certificate helper:

```sh
ESP_DEV_CERT_NAME=<project>-dev node ./scripts/build.mjs \
  --watch \
  --serve \
  --host=0.0.0.0
```

You can still pass explicit `--certfile` and `--keyfile` paths if you need to override this behavior.

The HTTPS port is [derived per checkout](../README.md#dev-server-ports) rather than fixed — the runner prints it on startup (`Serving https://…`), and `npm run ports` reports it without starting a server. On the Mac, open that URL. From iOS/iPadOS, use one of the LAN URLs printed by `cert:dev --verbose`.

## Install on iOS or iPadOS

1. Run `npm run cert:dev` from the project root.
2. Send the mkcert root CA to the iPhone or iPad.

   Common options:

   ```sh
   open "$(mkcert -CAROOT)"
   ```

   Then AirDrop the `rootCA.pem` file, or attach it to yourself using a trusted channel.

3. On the iOS/iPadOS device, open the received `rootCA.pem` file.
4. When prompted, allow the configuration profile to be downloaded.
5. Open `Settings`.
6. Go to `Profile Downloaded`, or `Settings > General > VPN & Device Management`.
7. Install the downloaded profile.
8. Go to `Settings > General > About > Certificate Trust Settings`.
9. Enable full trust for the mkcert root CA.
10. Open the HTTPS LAN URL printed by `npm run cert:dev --verbose`, for example:

    ```text
    https://192.168.0.1:8089/
    https://192.168.1.1:8089/
    https://10.0.0.1:8089/
    https://10.0.1.1:8089/
    ```

    The port shown there comes from `HTTPS_PORT` and defaults to `8443`, which is *not* your derived HTTPS port. Pass yours so the printed URLs are the ones you can actually open:

    ```sh
    npm run ports                                   # https=8089
    HTTPS_PORT=8089 npm run cert:dev -- --verbose
    ```

If Safari or another browser still shows a certificate warning, close and reopen the browser tab. If the device moved to another network and the Mac has a new LAN IP, regenerate the certificate with `ESP_DEV_CERT_FORCE=1 npm run cert:dev`, reinstall `rootCA.pem` from `mkcert -CAROOT` if the CA changed, and restart the HTTPS server.

## CLI Reference

All flags and environment variables for `esp-generate-dev-cert`:

| Flag / Variable | Default | Description |
|----------------|---------|-------------|
| `--trust` | off | Trust or retrust the mkcert CA even when reusing an existing certificate |
| `--skip-trust` | off | Do not trust the mkcert CA after generating |
| `--verbose` / `-v` | off | Print certificate paths and LAN URLs |
| `CAROOT` | mkcert default | Optional mkcert CA directory override |
| `ESP_DEV_CERT_NAME` | `<package-name>-dev` | Base name for the cert and key files |
| `ESP_DEV_CERTS_DIR` | `.esp_dev_certs` | Directory for cert files; set this outside the repo if you want certs to survive cleanup commands such as `git clean` |
| `ESP_DEV_CERT_HOSTS` | — | Comma-separated extra hostnames/IPs to include in the cert |
| `ESP_DEV_CERT_FORCE` | `0` | Set to `1` to regenerate even if the cert already exists |
| `HTTPS_PORT` / `PORT` | `8443` | Port shown in verbose LAN URL output. Set it to this checkout's derived HTTPS port (`npm run ports`), since the runner no longer serves on a fixed `8443` |

The esbuild runner also reads `ESP_DEV_CERT_NAME` and `ESP_DEV_CERTS_DIR`. When `ESP_DEV_CERT_NAME` is set and explicit `--certfile` / `--keyfile` paths are not provided, it uses `<ESP_DEV_CERTS_DIR>/<ESP_DEV_CERT_NAME>.pem` and `<ESP_DEV_CERTS_DIR>/<ESP_DEV_CERT_NAME>-key.pem`.

## Troubleshooting

If Chrome shows `Your connection is not private` for the HTTPS dev URL, check the advanced error code.

`NET::ERR_CERT_AUTHORITY_INVALID` means the CA is not trusted by the browser. Run:

```sh
npm run cert:dev -- --trust
```

Then restart the browser debug window.

`NET::ERR_CERT_COMMON_NAME_INVALID` or an IP/hostname mismatch means the certificate does not include the host you are using. Regenerate it:

```sh
ESP_DEV_CERT_FORCE=1 npm run cert:dev
```

Then restart the HTTPS server.
