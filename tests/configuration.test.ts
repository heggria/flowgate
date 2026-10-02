import test from "node:test";
import assert from "node:assert/strict";
import {
  compileConfiguration,
  initialConfiguration,
  validateConfiguration,
} from "../packages/domain/src/configuration";

test("DNS URLs with unsupported fragment semantics are rejected before save or compilation", () => {
  for (const address of [
    "udp://1.1.1.1#Pick",
    "tls://dns.example#RULES",
    "https://dns.example/dns-query#h3=true",
  ]) {
    for (const external of [false, true]) {
      const configuration = initialConfiguration();
      if (external)
        configuration.externalNetworks = [
          {
            id: "fixture",
            name: "Fixture",
            interface: "lo0",
            dnsServer: address,
          },
        ];
      else configuration.settings.dnsServer = address;
      for (const check of [validateConfiguration, compileConfiguration]) {
        assert.throws(
          () => check(configuration),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, external ? /外部网络 DNS/ : /DNS 地址/);
            assert.match(error.message, /路由|附加参数/);
            assert.doesNotMatch(error.message, /Pick|RULES|h3=true/);
            return true;
          },
        );
      }
    }
  }
});

test("typed IPv6 DNS servers use bare literals for primary and external resolvers", () => {
  for (const protocol of ["udp", "tls", "https"]) {
    const configuration = initialConfiguration();
    configuration.settings.dnsServer = `${protocol}://[::1]:5353${protocol === "https" ? "/dns-query?fixture=primary" : ""}`;
    configuration.externalNetworks = [
      {
        id: "fixture",
        name: "Fixture",
        interface: "lo0",
        dnsServer: `${protocol}://[2001:db8::1]:5354${protocol === "https" ? "/dns-query?fixture=external" : ""}`,
      },
    ];
    const compiled = compileConfiguration(configuration);
    const primary: any = compiled.dns.servers.find((s) => s.tag === "resolver");
    const external: any = compiled.dns.servers.find(
      (s) => s.tag === "dns-fixture",
    );
    assert.equal(primary.server, "::1");
    assert.equal(external.server, "2001:db8::1");
    assert.equal(primary.server_port, 5353);
    assert.equal(external.server_port, 5354);
    assert.equal(external.detour, "fixture");
    if (protocol === "https") {
      assert.equal(primary.path, "/dns-query?fixture=primary");
      assert.equal(external.path, "/dns-query?fixture=external");
    }
  }
});

test("DNS normalization preserves ordinary hostnames, IPv4 and encoded DoH query data", () => {
  for (const host of ["dns.example", "192.0.2.1"]) {
    const configuration = initialConfiguration();
    configuration.settings.dnsServer = `https://${host}/dns-query?fixture=value%23content`;
    const primary: any = compileConfiguration(configuration).dns.servers.find(
      (s) => s.tag === "resolver",
    );
    assert.equal(primary.server, host);
    assert.equal(primary.path, "/dns-query?fixture=value%23content");
  }
});

test("UDP and TLS DNS paths or query parameters are rejected for all resolvers", () => {
  for (const address of [
    "udp://1.1.1.1/fixture-path",
    "udp://1.1.1.1?fixture=value",
    "tls://dns.example/fixture-path",
    "tls://dns.example?fixture=value",
    "tls://[::1]:853/fixture-path?fixture=value",
  ]) {
    for (const external of [false, true]) {
      const configuration = initialConfiguration();
      if (external)
        configuration.externalNetworks = [
          {
            id: "fixture",
            name: "Fixture",
            interface: "lo0",
            dnsServer: address,
          },
        ];
      else configuration.settings.dnsServer = address;
      for (const check of [validateConfiguration, compileConfiguration]) {
        assert.throws(
          () => check(configuration),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, external ? /外部网络 DNS/ : /DNS 地址/);
            assert.match(error.message, /路径|查询参数/);
            assert.doesNotMatch(error.message, /fixture-path|fixture=value/);
            return true;
          },
        );
      }
    }
  }
});
