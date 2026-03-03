export const ADJECTIVES = ['Able', 'Amazing', 'Amusing', 'Awesome', 'Best', 'Better', 'Blessed'];
export const NOUNS = ['Badger', 'Bear', 'Beaver', 'Cat', 'Dog', 'Dolphin', 'Donkey'];

export const EVENT_TYPES = {
    SYSTEM_INIT: 'SYSTEM_INIT',
    USER_JOINED: 'USER_JOINED',
    USER_LEFT: 'USER_LEFT',
    SYSTEM_ONLINE_COUNT: 'SYSTEM_ONLINE_COUNT',
    CHAT_MESSAGE: 'CHAT_MESSAGE',
    UPDATE_NICKNAME: 'UPDATE_NICKNAME',
    USER_UPDATED: 'USER_UPDATED',
    SIGNAL: 'SIGNAL',
    SYSTEM_NOTIFICATION: 'SYSTEM_NOTIFICATION',
    CHAT_CLEARED: 'CHAT_CLEARED',
    ADMIN_RESET: 'ADMIN_RESET',
};

export const PATHS = {
    CONFIG: '/config',
    EVENTS: '/events',
    HISTORY: '/history',
    SIGNAL: '/signal',
};

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
export const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export const MAX_HISTORY_BYTES = 12 * 1024 * 1024;
export const NICKNAME_MAX_LENGTH = 20;
export const PING_INTERVAL_MS = 15000;
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const RATE_LIMIT_MAX = 200;
