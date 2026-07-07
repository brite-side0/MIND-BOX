# Changelog

## 1.0.0 (2026-07-07)


### Features

* **disputes:** add disputes table and refund pool config ([2fb9da0](https://github.com/brite-side0/MIND-BOX/commit/2fb9da0e7d697ee9ddfb311336aa110c2ae06218))
* **disputes:** add submitUsdcTransfer for refund-pool payouts ([55e7f85](https://github.com/brite-side0/MIND-BOX/commit/55e7f851e6dcbd0051bf842295700d4e6cd78c7c))
* **disputes:** dispute lifecycle service and refund execution ([9f968ba](https://github.com/brite-side0/MIND-BOX/commit/9f968baf45ee6130ddf23bef223060c2877f2751))
* **disputes:** file, lookup, and admin-ruling endpoints ([a633b5c](https://github.com/brite-side0/MIND-BOX/commit/a633b5cd252819bf4f47bb3061613e023863d292))
* **leases:** add leases table, schema, and opaque token helpers ([0cd6e04](https://github.com/brite-side0/MIND-BOX/commit/0cd6e04fb97ba011256db312d3af08a605552682))
* **leases:** expiry sweeper worker ([31a70d5](https://github.com/brite-side0/MIND-BOX/commit/31a70d5c8fb9426b9efdf18d12d7c33c7c1097f2))
* **leases:** lease service with duration tiers and token validation ([f10b7f3](https://github.com/brite-side0/MIND-BOX/commit/f10b7f31151bfd27fdd7f3c80a34d13264c36656))
* **leases:** lease-aware paywall short-circuit ([245f256](https://github.com/brite-side0/MIND-BOX/commit/245f256676b6c2ac81e1d882a2f94ba961aea1b3))
* **leases:** purchase, list, and revoke endpoints ([08a9db4](https://github.com/brite-side0/MIND-BOX/commit/08a9db480ccf91b821871dab084d6c8aaa602980))
* **payments:** record settlement tx on paid delivery ([7052a54](https://github.com/brite-side0/MIND-BOX/commit/7052a54cc7385de8b0c08d7d70eda710c30fa1d4))
* **payments:** settlement-tx audit column and X-PAYMENT-RESPONSE decoder ([e5c4419](https://github.com/brite-side0/MIND-BOX/commit/e5c441935f00a6d12e0437ded55a7b6265babc16))
* **paywall:** stale-on-error fallback for on-chain price lookups ([5634cc6](https://github.com/brite-side0/MIND-BOX/commit/5634cc6195a4afdac2c392bf094a934070b001a9))
* **search:** add tsvector search_vector column and GIN index ([9f0ac70](https://github.com/brite-side0/MIND-BOX/commit/9f0ac703dce7f510b03bde09ad0bb0c7b89a5e4b))
* **search:** relevance-ranked full-text catalog query ([175a77b](https://github.com/brite-side0/MIND-BOX/commit/175a77bfd34206ec9992c5fd1ccef81aa4eea3c9))
* **security:** require request signatures by default in production ([ee017c2](https://github.com/brite-side0/MIND-BOX/commit/ee017c2faa88e7f101a7740d2560498c96217ee1))
