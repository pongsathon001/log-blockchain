// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract LogStorage {
    address public owner;
    
    // โครงสร้างสำหรับเก็บข้อมูลของแต่ละ Block (1 Block = 20 Logs)
    struct BlockEntry {
        string blockHash;   // Master Hash ของ 20 Logs
        uint256 timestamp;  // เวลาที่ประทับตราบนเชน
        address recorder;   // กระเป๋าที่ทำการบันทึก
    }

    // เก็บข้อมูลแยกตามชื่อ Block (เช่น "BLOCK_1", "BLOCK_2")
    mapping(string => BlockEntry) private blocks;
    
    // Event แจ้งเตือนเมื่อมีการบันทึก Block ใหม่สำเร็จ
    event BlockSecured(string indexed blockId, string blockHash, uint256 timestamp);

    constructor() {
        owner = msg.sender;
    }

    // จำกัดสิทธิ์ให้เฉพาะเจ้าของระบบ (Backend ของเรา) เป็นคนส่งข้อมูลได้
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    // 🚀 นี่คือฟังก์ชันที่ Node.js ของเรากำลังตามหาครับ!
    function addLog(string memory _blockId, string memory _blockHash) public onlyOwner {
        blocks[_blockId] = BlockEntry({
            blockHash: _blockHash,
            timestamp: block.timestamp,
            recorder: msg.sender
        });

        emit BlockSecured(_blockId, _blockHash, block.timestamp);
    }

    // 🔍 ฟังก์ชันดึงข้อมูล: เพื่อให้ Node.js ดึงไปตรวจสอบ (Audit) ว่าตรงกับใน Database ไหม
    function getLog(string memory _blockId) public view returns (string memory, uint256, address) {
        BlockEntry memory entry = blocks[_blockId];
        require(bytes(entry.blockHash).length > 0, "Block not found");
        
        return (entry.blockHash, entry.timestamp, entry.recorder);
    }
}