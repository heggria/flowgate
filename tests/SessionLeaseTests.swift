import Foundation

@main struct SessionLeaseTests {
    static func main() throws {
        let lease = SessionLease()
        let first = lease.acquire()!
        precondition(lease.isActive(first))
        precondition(lease.beginCleanup(first))
        precondition(!lease.isActive(first))
        var restores = 0
        do {
            try lease.cleanup(first) { restores += 1; throw NSError(domain: "injected", code: 1) }
            fatalError("Expected restore failure")
        } catch {}
        precondition(lease.acquire() == nil, "Failed restoration must retain admission fence")
        try lease.cleanup(first) { restores += 1 }
        let second = lease.acquire()!
        precondition(second != first && lease.isActive(second))
        precondition(!lease.beginCleanup(first))
        let stale = try lease.cleanup(first) { restores += 1 }
        precondition(!stale && restores == 2, "Old retry must not touch a new session's resources")
        precondition(lease.isActive(second))
        precondition(lease.beginCleanup(second))
        try lease.cleanup(second) { restores += 1 }
        precondition(restores == 3)
        print("PASS: helper cleanup generations and recovery admission fence")
    }
}
