// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract LogStorage {
    address public owner;

    struct LogEntry {
        string logHash;
        uint256 timestamp;
        address recorder;
    }

    mapping(string => LogEntry) private logs;
    event LogStored(string indexed logId, string logHash, uint256 timestamp);

    constructor() {
        owner = msg.sender; // ตั้งค่าคน Deploy เป็นเจ้าของ
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    // บันทึกรายการเดียว (ใส่ onlyOwner เพื่อความปลอดภัย)
    function storeLog(string memory _logId, string memory _logHash) public onlyOwner {
        require(bytes(logs[_logId].logHash).length == 0, "Log ID already exists");
        logs[_logId] = LogEntry({
            logHash: _logHash,
            timestamp: block.timestamp,
            recorder: msg.sender
        });
        emit LogStored(_logId, _logHash, block.timestamp);
    }

    // ใหม่: ฟังก์ชันบันทึกทีละหลายรายการ (Batch) ประหยัดค่า Gas
    function batchStoreLogs(string[] memory _logIds, string[] memory _logHashes) public onlyOwner {
        require(_logIds.length == _logHashes.length, "Arrays length mismatch");
        for (uint i = 0; i < _logIds.length; i++) {
            if (bytes(logs[_logIds[i]].logHash).length == 0) {
                logs[_logIds[i]] = LogEntry({
                    logHash: _logHashes[i],
                    timestamp: block.timestamp,
                    recorder: msg.sender
                });
                emit LogStored(_logIds[i], _logHashes[i], block.timestamp);
            }
        }
    }

    function getLog(string memory _logId) public view returns (string memory, uint256, address) {
        LogEntry memory entry = logs[_logId];
        require(bytes(entry.logHash).length > 0, "Log not found");
        return (entry.logHash, entry.timestamp, entry.recorder);
    }
}