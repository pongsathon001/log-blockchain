// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract LogStorage {
    struct LogEntry {
        string logHash;    // เก็บค่า SHA-256 Hash
        uint256 timestamp; // เวลาที่บันทึกบน Blockchain
        address recorder;  // Wallet address ของคนที่บันทึก
    }

    // เก็บข้อมูลในรูปแบบ logId => ข้อมูล Log
    mapping(string => LogEntry) private logs;

    // Event สำหรับให้ Backend จับสัญญาณได้ว่าบันทึกสำเร็จ
    event LogStored(string indexed logId, string logHash, uint256 timestamp);

    // ฟังก์ชันสำหรับบันทึก Hash ใหม่
    function storeLog(string memory _logId, string memory _logHash) public {
        // เช็คว่า ID นี้ไม่เคยถูกบันทึกมาก่อน (ป้องกันการทับซ้อน)
        require(bytes(logs[_logId].logHash).length == 0, "Log ID already exists");

        logs[_logId] = LogEntry({
            logHash: _logHash,
            timestamp: block.timestamp,
            recorder: msg.sender
        });

        emit LogStored(_logId, _logHash, block.timestamp);
    }

    // ฟังก์ชันสำหรับดึงข้อมูลมา Verify
    function getLog(string memory _logId) public view returns (string memory, uint256, address) {
        LogEntry memory entry = logs[_logId];
        require(bytes(entry.logHash).length > 0, "Log not found");
        return (entry.logHash, entry.timestamp, entry.recorder);
    }
}