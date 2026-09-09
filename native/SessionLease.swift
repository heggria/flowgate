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
        guard owner == generation else { return false }
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
