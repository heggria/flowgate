# FlowGate business update repository

This branch serves TUF-authenticated business Release Sets over HTTPS. It contains public metadata and immutable content only. Private signing keys are not stored here.

Current stable business release: `business-279d22fd0607`, monotonic version `2026091002`, built from clean source `279d22fd0607e2ec64246ee134898fadf3c963f6`. [The final integrated source passed CI](https://github.com/heggria/flowgate/actions/runs/34391306288), and its tree matches protected main merge `7459345dc6d1827718ba0d618bf47fec77736b3e`. Older shells need the new complete development application before accepting the expanded built-in catalog; business updates never replace native permission boundaries. Apple signing remains deferred.

Online-only metadata maintenance has been exercised successfully: [refresh run](https://github.com/heggria/flowgate/actions/runs/34392091185). Root and targets signing material is not present in that workflow.

Initial release: `business-75a07d246aba`, source commit `75a07d246abac4e3f1c044d525123c6dedb61fb2`, built from a clean macOS arm64 checkout. The source passed [remote verification](https://github.com/heggria/flowgate/actions/runs/34386091996). The `stable` business channel is independent of Apple production signing: this remains a development application with privileged acceptance deferred.

Use the publisher and maintenance procedures on protected `main`; never manually edit signed metadata. Every publication is one Git commit. Concurrent non-fast-forward pushes must be retried from the newest branch, with a freshly prepared signing request.
