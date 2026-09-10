# macOS platform integration

FlowGate 0.3.1 adds application identity, a working menu-bar extra and explicit native application conventions. The design target is Apple's published macOS 27 guidance. Implementation and validation are different claims: the development machine is macOS 26.6.2, and this release has not been qualified on a macOS 27 device.

## Brand and symbols

`assets/brand/mark.json` is the editable geometry source: an open gateway with two routed streams. The application uses a dark teal tile, a light gateway and mint streams. The sidebar uses the same geometry. Navigation symbols use a consistent 24-unit grid, rounded stroke ends and an optical stroke weight suited to small controls. Decorative SVGs are hidden from accessibility APIs; their controls retain text or accessible labels.

`app-icon.svg` and `app-icon.png` provide the full mark. `FlowGate.icns` contains 16, 32, 128, 256 and 512-point variants with Retina representations up to 1024 pixels. `scripts/render-icons.cjs` regenerates these committed images in a hidden Electron renderer using the shared geometry and native `iconutil`. It neither opens a visible window nor takes focus. The generated `.icns` is a static macOS icon; it is not an Icon Composer layered icon and must not be described as supporting the system's dynamic clear/tinted layered-icon variants.

The build inventories the application icon and both menu-bar images. Packaging sets `CFBundleIconFile` to FlowGate's own icon and verifies the copied bytes; it no longer inherits Electron's icon. Source SVG/PNG assets remain editable for a future Icon Composer build when the full Apple toolchain is available.

## Menu-bar extra

The previous inline PNG decoded as an empty `NativeImage`, leaving the native tray with no visible symbol. The new `menuBarTemplate.png` and `menuBarTemplate@2x.png` are valid 18-point template representations at 72/144 dpi; macOS controls their light/dark rendering. A stable UUID identifies the item across launches so the system can preserve its position. Empty-image fallback displays the short title `FG`, preventing an invisible target.

The menu reports kernel state and whether a configuration is waiting to be applied. Opening the menu does not activate the main window; opening FlowGate or Settings is an explicit action. A stopped proxy offers Start; a running proxy offers Stop; startup/unavailable states disable control. A repeated snapshot does not rebuild the menu, and repeated installation does not create another item. The shell retains ownership across renderer replacement and disposes the item during successful application shutdown. Normal Start and Stop use the Service transaction path; the existing native recovery stop remains available when the Service cannot be used. No menu action implicitly connects a proxy or edits global networking without a user action.

## Application and window conventions

The native application menu provides About, Settings (`Command+,`), Services, Hide, Hide Others and Quit. Native Edit and Window roles preserve standard editing, minimization and window behavior. View includes command search (`Command+K`), zoom, full screen and appearance choices. Menu navigation is queued until the renderer is ready, including window recreation. No arbitrary page script or external business module is loaded through this interface.

The close button and `Command+W` close the window without quitting the background network utility. Reopening from the Dock or menu restores the window. The first window is shown after its first paint. `Command+Q` retains the existing orderly Service/native cleanup. Isolated automated tests remain hidden and non-focusable.

Menus use native AppKit-backed roles and text rather than forcing custom images onto every action. This is intentional: macOS 27 changes the default visibility of menu-item images; native roles allow common system actions to follow platform policy.

## Appearance and accessibility

Fresh installations follow the system appearance. Explicit light/dark preferences remain supported. Native menu choices, the renderer toggle and persisted preferences stay synchronized. A source change that leaves the same visible colors still broadcasts the preference, so changing light to system is not lost. Native theme and preference subscriptions are removed when their owner is disposed.

Native high-contrast and reduced-transparency preferences are sent through a bounded shell contract. High contrast strengthens shared borders and text; reduced transparency removes dialog backdrop blur. Existing reduced-motion, forced-color, focus visibility and textual status cues remain. Material and content backgrounds prioritize readability; ordinary data tables are not given decorative glass effects.

## Qualification status

| Area | Implemented | Validation boundary |
| --- | --- | --- |
| Application identity and image inventory | Own ICNS, native package metadata, shared SVG mark | PNG decode/alpha/Retina checks and packaged icon hash |
| Menu-bar state and lifecycle | Valid template images, native menus, state and cleanup | Native image and native Menu APIs; tray instance is substituted in hidden automation, so live screen placement is not claimed |
| Native application menus | Standard roles, shortcuts, ready-aware navigation | Real hidden Electron application exercises Settings/search and menu-to-renderer behavior |
| System appearance | System/light/dark and explicit propagation | Real Electron nativeTheme and renderer synchronization |
| Accessibility preferences | Contrast/transparency and existing keyboard/motion behavior | CSS fixtures plus native preference reads; no full VoiceOver or changed global accessibility-setting acceptance |
| macOS 27 runtime | Public guidance reviewed | Actual macOS 27 machine still required |
| Layered app icon and native Liquid Glass custom controls | Not delivered by the current static icon/web-content approach | Icon Composer/SDK implementation and device qualification still required before claiming full visual adoption |
| Signing and privileged modes | Existing architecture retained | Developer ID, notarization and privileged-device acceptance remain user-deferred |

`tests/macos.integration.mjs` is included in full verification. `tests/package.integration.mjs` validates the installed icon, package identity, signature integrity and actual proxy traffic. These checks do not establish universal macOS 27 conformance.

## Primary references

- [Apple macOS 27](https://www.apple.com/os/macos/)
- [macOS 27 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)
- [Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Apple menu bar guidance](https://developer.apple.com/design/human-interface-guidelines/the-menu-bar)
- [Apple materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray)
- [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme)
