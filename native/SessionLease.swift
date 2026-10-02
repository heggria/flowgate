import Foundation

// All access is confined to the helper's serial writer queue.
final class SessionLease {
    private var nextGeneration: UInt64 = 0
    private var owner: UInt64?
    private var cleaning = false

    func acquire() -> UInt64? {
        guard owner == nil else { return nil }
        nextGeneration += 1
        owner = nextGeneration
        cleaning = false
        return nextGeneration
    }
    func isActive(_ generation: UInt64) -> Bool {
        return owner == generation && !cleaning
    }
    func beginCleanup(_ generation: UInt64) -> Bool {
        guard owner == generation && !cleaning else { return false }
        cleaning = true
        return true
    }
    @discardableResult
    func cleanup(_ generation: UInt64, restore: () throws -> Void) throws -> Bool {
        guard owner == generation && cleaning else { return false }
        try restore()
        owner = nil
        cleaning = false
        return true
    }
}

// One recovery chain per generation. Like SessionLease, all calls and scheduled
// retries must execute on the helper's serial writer queue. A failed restore
// keeps admission fenced indefinitely, with exponential backoff capped at 30s.
final class SessionCleanup {
    typealias Scheduler = (TimeInterval, @escaping () -> Void) -> Void
    private final class RetryTicket {}
    private let lease: SessionLease
    private let generation: UInt64
    private var pendingRetry: RetryTicket?
    private var nextDelay: TimeInterval = 1

    init(lease: SessionLease, generation: UInt64) {
        self.lease = lease
        self.generation = generation
    }

    func start(restore: @escaping () throws -> Void, schedule: @escaping Scheduler,
               failed: @escaping () -> Void, completed: @escaping () -> Void) {
        guard lease.beginCleanup(generation) else { return }
        attempt(restore: restore, schedule: schedule, failed: failed, completed: completed)
    }

    private func attempt(restore: @escaping () throws -> Void, schedule: @escaping Scheduler,
                         failed: @escaping () -> Void, completed: @escaping () -> Void) {
        do {
            if try lease.cleanup(generation, restore: restore) { completed() }
        } catch {
            failed()
            let ticket = RetryTicket()
            pendingRetry = ticket
            let delay = nextDelay
            nextDelay = min(nextDelay * 2, 30)
            schedule(delay) {
                // Even a duplicated/late callback cannot fork a retry chain.
                guard self.pendingRetry === ticket else { return }
                self.pendingRetry = nil
                self.attempt(restore: restore, schedule: schedule, failed: failed, completed: completed)
            }
        }
    }
}
