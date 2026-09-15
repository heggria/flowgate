import test from "node:test";
import assert from "node:assert/strict";
import {
  initialConfiguration,
  validateConfiguration,
} from "../packages/domain/src/configuration";

test("malformed DNS addresses fail with actionable messages before saving", () => {
  for (const address of [
    "invalid-dns",
    "",
    "udp://",
    "tls://",
    "https://",
    "https://user:secret@example.com/dns-query",
    "ftp://example.com",
  ]) {
    for (const external of [false, true]) {
      const configuration = initialConfiguration();
      if (external)
        configuration.externalNetworks = [
          { id: "vpn", name: "VPN", interface: "utun5", dnsServer: address },
        ];
      else configuration.settings.dnsServer = address;
      assert.throws(
        () => validateConfiguration(configuration),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, external ? /外部网络 DNS/ : /DNS 地址/);
          assert.match(error.message, /HTTPS.*TLS.*UDP/);
          assert.doesNotMatch(error.message, /Invalid URL|secret/);
          return true;
        },
      );
    }
  }
  for (const address of [
    "udp://[::1]:5353",
    "tls://dns.example",
    "https://dns.example/dns-query?dns=test",
  ]) {
    const configuration = initialConfiguration();
    configuration.settings.dnsServer = address;
    assert.doesNotThrow(() => validateConfiguration(configuration));
  }
});
