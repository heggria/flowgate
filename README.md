# FlowGate business update repository

This branch serves TUF-authenticated business Release Sets over HTTPS. It contains public metadata and immutable content only. Private signing keys are not stored here.

Initial release: `business-75a07d246aba`, source commit `75a07d246abac4e3f1c044d525123c6dedb61fb2`, built from a clean macOS arm64 checkout. The source passed [remote verification](https://github.com/heggria/flowgate/actions/runs/34386091996). The `stable` business channel is independent of Apple production signing: this remains a development application with privileged acceptance deferred.

Use the publisher and maintenance procedures on protected `main`; never manually edit signed metadata. Every publication is one Git commit. Concurrent non-fast-forward pushes must be retried from the newest branch, with a freshly prepared signing request.
