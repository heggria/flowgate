import Foundation
import Darwin

// Deliberately use macOS URLSession proxy discovery, not an explicit curl proxy.
@main struct SystemHTTPProbe {
    static func main() async {
        guard CommandLine.arguments.count == 2,
              let url = URL(string: CommandLine.arguments[1]),
              url.scheme == "http", url.host == "198.18.0.88" else { exit(64) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration)
        do {
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  String(data: data, encoding: .utf8) == "flowgate-privileged-origin" else {
                fputs("Unexpected system proxy response\n", stderr)
                exit(1)
            }
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }
    }
}
