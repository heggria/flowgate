import Foundation
@objc protocol FlowGateHelperProtocol {
    func request(_ data: Data, reply: @escaping (Data) -> Void)
}
