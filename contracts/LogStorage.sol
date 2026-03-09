// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract LogStorage {
    address public owner;
    
    // 🔗 เพิ่มตัวแปรเก็บ Hash ตัวล่าสุดของโซ่ (The Tail of the Chain)
    string public lastRootHash;
    uint256 public totalNodes;

    struct LogEntry {
        string logHash;      // Hash ของข้อมูลปัจจุบัน + Hash ก่อนหน้า
        uint256 timestamp;
        address recorder;
        uint256 blockNumber; // เก็บเลข Block ไว้ตรวจสอบย้อนหลังได้ง่ายขึ้น
    }

    // เก็บข้อมูลแยกตาม ID (สำหรับตรวจสอบรายคน)
    mapping(string => LogEntry) private logs;
    
    event ChainUpdated(string indexed logId, string newHash, string previousHash, uint256 timestamp);

    constructor() {
        owner = msg.sender;
        lastRootHash = "0000000000000000000000000000000000000000000000000000000000000000"; // ค่าเริ่มต้น
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    // ฟังก์ชันบันทึกข้อมูลแบบ Chain (บันทึกต่อกันทีละคน)
    function storeChainLog(string memory _logId, string memory _newHash) public onlyOwner {
        // บันทึกข้อมูลลง Mapping
        logs[_logId] = LogEntry({
            logHash: _newHash,
            timestamp: block.timestamp,
            recorder: msg.sender,
            blockNumber: block.number
        });

        // อัปเดต Root ล่าสุดของโซ่
        string memory oldRoot = lastRootHash;
        lastRootHash = _newHash;
        totalNodes++;

        emit ChainUpdated(_logId, _newHash, oldRoot, block.timestamp);
    }

    // ฟังก์ชันบันทึกแบบ Batch สำหรับ Hash Chain (ประหยัดค่า Gas)
    function batchStoreChain(string[] memory _logIds, string[] memory _logHashes) public onlyOwner {
        require(_logIds.length == _logHashes.length, "Arrays mismatch");
        
        for (uint i = 0; i < _logIds.length; i++) {
            logs[_logIds[i]] = LogEntry({
                logHash: _logHashes[i],
                timestamp: block.timestamp,
                recorder: msg.sender,
                blockNumber: block.number
            });
        }

        // อัปเดต Root เป็นตัวสุดท้ายของ Batch ที่ส่งมา
        lastRootHash = _logHashes[_logHashes.length - 1];
        totalNodes += _logIds.length;
    }

    // ดึงข้อมูล Hash มาตรวจสอบ
    function getLog(string memory _logId) public view returns (string memory, uint256, address, uint256) {
        LogEntry memory entry = logs[_logId];
        require(bytes(entry.logHash).length > 0, "Log not found");
        return (entry.logHash, entry.timestamp, entry.recorder, entry.blockNumber);
    }
}