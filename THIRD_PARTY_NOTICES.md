# Third-party notices

Eir is distributed under GPL-3.0-only. The complete license is in LICENSE.

- Omron protocol adaptation: eigger/hass-omron, MIT, copyright 2025 eigger. The original notice is preserved in firmware/LICENSE.omron and licenses/omron-MIT.txt.
- AFU scale protocol and Segal estimation adaptation: Xuan-lprk/smart-body-scale-IOS, revision c11f1b925653b5d14b46eb3b02f6d68551d7e944, GPL-3.0-only. The original license is preserved in internal/afu/LICENSE.upstream, firmware/LICENSE.afu and licenses/afu-GPL-3.0.txt.
- ESP-IDF and managed components retain their own licenses. firmware/dependencies.lock identifies the managed component versions; the ESP-IDF build uses v6.1.
- Go module and JavaScript package dependencies retain their original licenses. Exact versions are in go.mod, go.sum and web/package-lock.json.
- The runtime includes Alpine Linux packages for certificate handling, PDF rendering and HEIC conversion. These packages retain their respective licenses and are installed from the official Alpine repositories.

Published application and firmware builds identify their source commit. Firmware releases include an archive of the corresponding Eir sources and the locked dependency manifests, together with reproducible build instructions. Source and notices are available at https://github.com/cloverstd/Eir.
