const { MongoClient } = require('mongodb');
const fs = require('fs');
const yaml = require('js-yaml');
const { ObjectId } = require('mongodb');
const path = require('path');

// Load configuration
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../../config.yml'), 'utf8'));

let client;
let db;

async function connect() {
    try {
        client = new MongoClient(config.database.uri);
        await client.connect();
        db = client.db('mcb_moderation');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        process.exit(1);
    }
}

async function close() {
    if (client) {
        await client.close();
    }
}

// Moderator Action Tracking
async function trackWarningAction(moderatorId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('moderatorWarnings');
    await collection.insertOne({
        moderatorId,
        timestamp: new Date()
    });
}

async function trackMessageDeletion(moderatorId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('moderatorDeletions');
    await collection.insertOne({
        moderatorId,
        timestamp: new Date()
    });
}

async function getModeratorStats(timeRange) {
    if (!db) throw new Error('Database not connected');
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - timeRange);
    
    const warningsCollection = db.collection('moderatorWarnings');
    const deletionsCollection = db.collection('moderatorDeletions');
    
    const pipeline = [
        {
            $match: {
                timestamp: { $gte: startDate }
            }
        },
        {
            $group: {
                _id: "$moderatorId",
                count: { $sum: 1 }
            }
        }
    ];
    
    const warningStats = await warningsCollection.aggregate(pipeline).toArray();
    const deletionStats = await deletionsCollection.aggregate(pipeline).toArray();
    
    return {
        warnings: warningStats,
        deletions: deletionStats
    };
}

// Warning operations
async function addWarning(userId, reason, warnedBy, timestamp) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('warnings');
    await collection.insertOne({
        userId,
        reason,
        warnedBy,
        timestamp,
        expiresAt: timestamp + (config.warnings.warningExpirationDays * 24 * 60 * 60 * 1000)
    });
    
    // Track the moderator action
    await trackWarningAction(warnedBy);
}

async function getUserWarnings(userId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('warnings');
    const now = Date.now();
    
    // Get active warnings
    const warnings = await collection.find({
        userId,
        expiresAt: { $gt: now }
    }).toArray();

    // Delete expired warnings
    await collection.deleteMany({
        userId,
        expiresAt: { $lte: now }
    });

    return warnings;
}

async function getWarningCount(userId) {
    if (!db) throw new Error('Database not connected');
    const warnings = await getUserWarnings(userId);
    return warnings.length;
}

async function shouldMuteUser(userId) {
    if (!db) throw new Error('Database not connected');
    const warningCount = await getWarningCount(userId);
    return warningCount >= config.warnings.maxWarnings;
}

// Mute operations
async function addMute(userId, reason, mutedBy, duration, timestamp) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('mutes');
    await collection.insertOne({
        userId,
        reason,
        mutedBy,
        duration,
        timestamp,
        expiresAt: timestamp + (duration * 60 * 60 * 1000)
    });
}

async function getUserMutes(userId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('mutes');
    const now = Date.now();
    
    // Get active mutes
    const mutes = await collection.find({
        userId,
        expiresAt: { $gt: now }
    }).toArray();

    // Delete expired mutes
    await collection.deleteMany({
        userId,
        expiresAt: { $lte: now }
    });

    return mutes;
}

async function isUserMuted(userId) {
    if (!db) throw new Error('Database not connected');
    const mutes = await getUserMutes(userId);
    return mutes.length > 0;
}

// Ban operations
async function addBan(userId, reason, bannedBy, timestamp) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('bans');
    await collection.insertOne({
        userId,
        reason,
        bannedBy,
        timestamp
    });
}

async function isUserBanned(userId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('bans');
    const ban = await collection.findOne({ userId });
    return ban !== null;
}

// Note functions
async function addNote(userId, authorId, content) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('notes');
    
    const note = {
        userId,
        authorId,
        content,
        timestamp: new Date(),
        active: true
    };
    
    await collection.insertOne(note);
    return note;
}

async function getUserNotes(userId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('notes');
    
    return await collection.find({ userId, active: true })
        .sort({ timestamp: -1 })
        .toArray();
}

async function removeNote(noteId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('notes');
    
    const result = await collection.updateOne(
        { _id: new ObjectId(noteId) },
        { $set: { active: false } }
    );
    
    return result.modifiedCount > 0;
}

async function removeWarning(warningId) {
    if (!db) throw new Error('Database not connected');
    try {
        const warnings = db.collection('warnings');
        
        // Convert warningId to ObjectId
        const _id = new ObjectId(warningId);
        
        // Remove the warning
        const result = await warnings.deleteOne({ _id });
        
        return result.deletedCount > 0;
    } catch (error) {
        console.error('Error removing warning:', error);
        throw error;
    }
}

// Reports operations
async function getUserReports(userId) {
    if (!db) throw new Error('Database not connected');
    const collection = db.collection('reports');
    return await collection.find({ userId })
        .sort({ timestamp: -1 })
        .toArray();
}

module.exports = {
    connect,
    close,
    // Warning operations
    addWarning,
    getUserWarnings,
    getWarningCount,
    shouldMuteUser,
    removeWarning,
    // Mute operations
    addMute,
    getUserMutes,
    isUserMuted,
    // Ban operations
    addBan,
    isUserBanned,
    // Note operations
    addNote,
    getUserNotes,
    removeNote,
    // Report operations
    getUserReports,
    // Moderator Stats operations
    trackMessageDeletion,
    getModeratorStats
}; 