import Foundation

// In-memory dependencies for the unmodified production HelperSession/Delegate.
// Virtual time runs serially, just like the helper writer queue. No XPC service,
// kernel, native preferences, real timer or global network setting is used.
struct DispatchTime {
    let delay: Double
    static func now() -> DispatchTime { DispatchTime(delay: 0) }
    static func + (lhs: DispatchTime, rhs: Double) -> DispatchTime { DispatchTime(delay: lhs.delay + rhs) }
}
final class DispatchQueue {
    struct Scheduled { let due: Double; let delay: Double; let run: () -> Void }
    var now = 0.0
    var pending: [Scheduled] = []
    var delays: [Double] = []
    init(label: String) {}
    func sync<T>(_ action: () -> T) -> T { action() }
    func async(execute action: @escaping () -> Void) { action() }
    func asyncAfter(deadline: DispatchTime, execute action: @escaping () -> Void) {
        delays.append(deadline.delay)
        pending.append(Scheduled(due: now + deadline.delay, delay: deadline.delay, run: action))
    }
    @discardableResult func runNext() -> Scheduled? {
        guard !pending.isEmpty else { return nil }
        let next = pending.removeFirst()
        now = next.due
        next.run()
        return next
    }
}
final class DispatchSourceTimer {
    var handler: (() -> Void)?
    var cancelled = false
    func schedule(deadline: DispatchTime, repeating: Int) {}
    func setEventHandler(handler: @escaping () -> Void) { self.handler = handler }
    func resume() {}
    func cancel() { cancelled = true }
}
enum DispatchSource {
    static func makeTimerSource(queue: DispatchQueue) -> DispatchSourceTimer { DispatchSourceTimer() }
}
protocol FlowGateHelperProtocol { func request(_ data: Data, reply: @escaping (Data) -> Void) }
final class NSXPCInterface { init(with type: FlowGateHelperProtocol.Protocol) {} }
final class NSXPCConnection {
    var effectiveUserIdentifier: UInt32 = 501
    var exportedInterface: NSXPCInterface?
    var exportedObject: AnyObject?
    var invalidationHandler: (() -> Void)?
    var interruptionHandler: (() -> Void)?
    func invalidate() { invalidationHandler?() }
    func resume() {}
}
final class NSXPCListener {}
protocol NSXPCListenerDelegate {}
final class NetworkEngine {
    var failuresRemaining = 0
    var stops = 0
    var reconciles = 0
    var requests = 0
    var lastError: String?
    func stop() throws {
        stops += 1
        if failuresRemaining > 0 {
            failuresRemaining -= 1
            throw NSError(domain: "injected restoration failure", code: 1)
        }
        lastError = nil
    }
    func reconcile() { reconciles += 1 }
    func request(_ data: Data) -> Data { requests += 1; return data }
}

@main struct SessionLeaseTests {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: message, code: 1) }
    }
    static func prolongedRecovery() throws {
        let engine = NetworkEngine()
        engine.failuresRemaining = 6
        let delegate = HelperDelegate(engine: engine)
        let listener = NSXPCListener()
        let first = NSXPCConnection()
        try expect(delegate.listener(listener, shouldAcceptNewConnection: first), "First connection must be admitted")
        first.invalidate()
        for attempt in 1...6 {
            try expect(engine.stops == attempt, "Expected restoration attempt \(attempt), got \(engine.stops); retries stopped while recovery remained pending")
            try expect(delegate.active === first, "Failed cleanup must retain the active connection")
            try expect(!delegate.listener(listener, shouldAcceptNewConnection: NSXPCConnection()), "Recovery must fence new connections")
            try expect(delegate.queue.runNext() != nil, "Recovery retry chain ended after \(attempt) failures")
        }
        try expect(engine.stops == 7 && delegate.active == nil, "Restoration must finish and release active admission")
        try expect(delegate.listener(listener, shouldAcceptNewConnection: NSXPCConnection()), "Backend recovery must admit a new connection without helper restart")
        print("PASS: production helper survives six restoration failures, fences admission, then admits a successor")
    }
    static func retrySafety() throws {
        let engine = NetworkEngine()
        engine.failuresRemaining = 18
        let delegate = HelperDelegate(engine: engine)
        let listener = NSXPCListener()
        let first = NSXPCConnection()
        try expect(delegate.listener(listener, shouldAcceptNewConnection: first), "First safety connection must be admitted")
        let session = first.exportedObject as! HelperSession
        session.monitor?.handler?()
        try expect(engine.reconciles == 1, "Active session monitor must reconcile")
        first.invalidate()
        try expect(session.monitor?.cancelled == true, "Cleanup must cancel monitor")
        session.monitor?.handler?()
        try expect(engine.reconciles == 1, "Queued monitor must not reconcile a cleaning session")
        var rejectedReply = Data()
        session.request(Data("{\"id\":\"ended\"}".utf8)) { rejectedReply = $0 }
        let reply = try JSONSerialization.jsonObject(with: rejectedReply) as! [String: Any]
        try expect(reply["error"] != nil && engine.requests == 0, "Cleaning session requests must not touch the engine")

        var stale: [DispatchQueue.Scheduled] = []
        var duplicateCompletions = 0
        for failure in 1...18 {
            for _ in 0..<5 {
                first.invalidate()
                session.cleanup { duplicateCompletions += 1 }
            }
            try expect(engine.stops == failure && delegate.queue.pending.count == 1, "Duplicate cleanup must retain exactly one retry chain")
            stale.forEach { $0.run() }
            try expect(engine.stops == failure && delegate.queue.pending.count == 1, "Replayed retry must not restore again or fork the chain")
            try expect(delegate.active === first && delegate.lease.acquire() == nil, "Retry backoff must retain both admission fences")
            guard let next = delegate.queue.runNext() else { throw NSError(domain: "Missing safety retry", code: 1) }
            try expect(next.delay > 0 && next.delay <= 30, "Retry delay must be positive and bounded")
            stale.append(next)
        }
        let expectedDelays: [Double] = [1, 2, 4, 8, 16] + Array(repeating: 30, count: 13)
        try expect(delegate.queue.delays == expectedDelays, "Backoff must grow to a stable 30-second cap and continue")
        try expect(engine.stops == 19 && delegate.active == nil && delegate.queue.pending.isEmpty, "Successful restore must end the retry chain")
        try expect(duplicateCompletions == 0, "Duplicate cleanup must not install extra completion handlers")

        let second = NSXPCConnection()
        try expect(delegate.listener(listener, shouldAcceptNewConnection: second), "New generation must be admitted after restoration")
        let successor = second.exportedObject as! HelperSession
        let stops = engine.stops
        stale.forEach { $0.run() }
        first.invalidate()
        session.monitor?.handler?()
        try expect(engine.stops == stops && delegate.active === second, "Late old-generation retries/cleanup must not stop or unlock the successor")
        try expect(delegate.lease.isActive(successor.generation) && successor.monitor?.cancelled == false, "Successor lease and monitor must remain active")
        successor.request(Data("new request".utf8)) { _ in }
        try expect(engine.requests == 1, "Successor must still serve requests")

        engine.failuresRemaining = 1
        second.invalidate()
        stale.forEach { $0.run() }
        first.invalidate()
        try expect(delegate.active === second && engine.stops == stops + 1 && delegate.queue.pending.count == 1, "Old retries must not interfere with a new generation's recovery")
        try expect(delegate.queue.pending.first?.delay == 1, "New generation must restart backoff at one second")
        try expect(!delegate.listener(listener, shouldAcceptNewConnection: NSXPCConnection()), "Successor recovery must retain admission fence")
        delegate.queue.runNext()
        try expect(delegate.active == nil && delegate.queue.pending.isEmpty, "Successor restoration must release only its own fence")
        try expect(delegate.listener(listener, shouldAcceptNewConnection: NSXPCConnection()), "A third generation must be admitted")
        print("PASS: production cleanup deduplicates retries, caps backoff at 30s, and fences late callbacks across active/cleaning generations")
    }
    static func run() throws {
        let lease = SessionLease()
        let first = lease.acquire()!
        precondition(lease.isActive(first))
        precondition(lease.beginCleanup(first))
        precondition(!lease.beginCleanup(first), "Repeated cleanup must not start another chain")
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
        try prolongedRecovery()
        try retrySafety()
    }
    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data("FAIL: \((error as NSError).domain)\n".utf8))
            exit(1)
        }
    }
}
