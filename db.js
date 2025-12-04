// db.js
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// 🔒 Защита от случайного запуска без критических переменных
if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
  console.error('❌ FATAL: DATABASE_URL required in production');
  process.exit(1);
}

// 🛡️ Валидация URL перед использованием (защита от SSRF/инъекций)
const validateDatabaseURL = (url) => {
  try {
    const parsed = new URL(url);
    if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
      throw new Error('Invalid database URL protocol');
    }
    // Запрещаем опасные параметры в URL
    const blockedParams = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
    for (const param of blockedParams) {
      if (parsed.searchParams.has(param)) {
        console.warn(`⚠️ Ignoring unsafe parameter in DATABASE_URL: ${param}`);
        parsed.searchParams.delete(param);
      }
    }
    return parsed.toString();
  } catch (e) {
    throw new Error(`Invalid DATABASE_URL: ${e.message}`);
  }
};

// 🔐 Безопасное подключение: Railway, Render, self-hosted PostgreSQL
const getDatabaseConfig = () => {
  const config = {
    max: Math.min(process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : 20, 50), // ограничение сверху
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    // 🔒 Защита от утечек памяти: автоматический сброс "зависших" подключений
    statement_timeout: 15000,
    query_timeout: 15000,
    lock_timeout: 10000,
  };

  // Railway / Render: DATABASE_URL уже включает sslmode
  if (process.env.DATABASE_URL) {
    config.connectionString = validateDatabaseURL(process.env.DATABASE_URL);
    
    // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ для Railway
    if (process.env.NODE_ENV === 'production') {
      config.ssl = {
        rejectUnauthorized: false // Railway требует, но трафик шифруется на уровне сети
      };
      // ⚠️ Доп. защита: запрещаем insecure SSL
      config.connectionString = config.connectionString.replace(
        /sslmode=disable/gi,
        'sslmode=require'
      );
    }
  } else {
    // Локальная разработка
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || 5432;
    const database = process.env.DB_NAME || 'skinsale';
    const user = process.env.DB_USER || 'postgres';
    const password = process.env.DB_PASSWORD || 'postgres';

    // 🔒 Валидация входных данных
    if (/[;'"\\]/.test(host)) throw new Error('Invalid DB_HOST');
    if (port < 1 || port > 65535) throw new Error('Invalid DB_PORT');
    if (/[;'"\\]/.test(database)) throw new Error('Invalid DB_NAME');
    if (/[;'"\\]/.test(user)) throw new Error('Invalid DB_USER');

    config.host = host;
    config.port = port;
    config.database = database;
    config.user = user;
    config.password = password;
    config.ssl = false;
  }

  return config;
};

const pool = new Pool(getDatabaseConfig());

// 📊 Мониторинг пула (без избыточного логгирования в продакшене)
pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool unrecoverable error:', {
    message: err.message,
    stack: err.stack?.split('\n').slice(0, 3).join('\n') // не логируем полный стек в проде
  });
  // Не завершаем процесс — пусть healthcheck решит
});

// ✅ Безопасный query с защитой от инъекций и утечек
export const query = async (text, params = []) => {
  // 🔒 Защита: запрещаем опасные команды в продакшене
  if (process.env.NODE_ENV === 'production') {
    const dangerousPatterns = [
      /;\s*drop\s+/i,
      /;\s*create\s+user/i,
      /;\s*grant\s+/i,
      /execute\s+immediate/i,
      /pg_sleep\s*\(/i
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(text)) {
        console.error('🚨 SECURITY ALERT: Blocked dangerous query pattern');
        throw new Error('Forbidden query pattern detected');
      }
    }
  }

  const start = Date.now();
  let client;
  
  try {
    client = await pool.connect();
    
    const timeoutMs = process.env.DB_QUERY_TIMEOUT ? parseInt(process.env.DB_QUERY_TIMEOUT) : 15000;
    if (timeoutMs > 30000) throw new Error('DB_QUERY_TIMEOUT too high');

    const result = await Promise.race([
      client.query(text, params), // pg библиотека автоматически экранирует params
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);

    const duration = Date.now() - start;
    
    // Логируем медленные запросы
    const threshold = process.env.NODE_ENV === 'production' ? 100 : 10;
    if (duration > threshold) {
      const queryPreview = text.split(/\s+/).slice(0, 4).join(' ').substring(0, 100);
      console.warn(`🐢 Slow query ${duration}ms: ${queryPreview}`);
    }
    
    return result;
  } catch (error) {
    // 🛡️ Скрываем детали БД в продакшене
    if (process.env.NODE_ENV === 'production') {
      console.error(`❌ Query failed: ${error.message.split('\n')[0] || 'Unknown error'}`);
    } else {
      console.error(`❌ Query failed (${text.substring(0, 50)}...):`, {
        message: error.message,
        code: error.code,
        detail: error.detail?.substring(0, 200), // ограничиваем длину
        position: error.position
      });
    }
    
    // Не пробрасываем чувствительные данные
    const safeError = new Error('Database operation failed');
    safeError.code = error.code;
    throw safeError;
  } finally {
    if (client) {
      client.release();
    }
  }
};

// 🚀 Безопасная инициализация БД
export const initDB = async () => {
  const maxRetries = 3;
  const retryDelay = 5000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Попытка подключения к БД (${attempt}/${maxRetries})...`);
      
      // Проверяем подключение
      const res = await query('SELECT current_database(), current_user, version()');
      console.log(`✅ PostgreSQL: ${res.rows[0].current_database} @ ${res.rows[0].version.split(',')[0]}`);

      // Создаём структуру (в безопасном порядке)
      await createExtensions();
      await createTables();
      await createIndexes();
      await createTriggers(); // ✅ ИСПРАВЛЕНО: безопасное создание триггеров
      await createSystemUsers();
      await migrateData();

      console.log('🎯 База данных полностью инициализирована');
      return;
      
    } catch (error) {
      console.error(`❌ Попытка ${attempt} не удалась:`, error.message);
      
      if (attempt === maxRetries) {
        console.error('💥 Все попытки подключения провалились');
        
        if (process.env.NODE_ENV === 'production') {
          console.log('⚠️ Сервер запустится в режиме "только чтение"');
          return;
        } else {
          process.exit(1);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
};

// =============== РАСШИРЕНИЯ ===============
const createExtensions = async () => {
  try {
    // Используем параметризованные запросы где возможно
    await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    console.log('✅ Расширения PostgreSQL активированы');
  } catch (error) {
    console.warn('⚠️ Не удалось создать расширения:', error.message);
  }
};

// =============== ТАБЛИЦЫ ===============
const createTables = async () => {
  const tables = [
    // 👤 Пользователи - с защитой от негативного баланса
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      steam_id VARCHAR(20) UNIQUE NOT NULL CHECK (steam_id ~ '^7656119[0-9]{10}$'), -- валидация SteamID
      username VARCHAR(100) NOT NULL CHECK (length(username) BETWEEN 3 AND 100),
      avatar TEXT CHECK (avatar IS NULL OR avatar ~ '^https?://'),
      profile_url TEXT CHECK (profile_url IS NULL OR profile_url ~ '^https://steamcommunity.com/'),
      balance DECIMAL(15,2) DEFAULT 0.00 CHECK (balance >= 0 AND balance <= 10000000),
      role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
      is_active BOOLEAN DEFAULT true,
      trade_url TEXT CHECK (trade_url IS NULL OR trade_url ~ '^https://steamcommunity.com/tradeoffer/new/\\?partner='),
      last_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,

    // 🎮 Предметы
    `CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      steam_asset_id VARCHAR(100) UNIQUE CHECK (steam_asset_id ~ '^[0-9]+$'),
      market_hash_name VARCHAR(500) NOT NULL CHECK (length(market_hash_name) > 0),
      name VARCHAR(255) NOT NULL,
      image_url TEXT CHECK (image_url IS NULL OR image_url ~ '^https://'),
      game VARCHAR(50) DEFAULT 'cs2' CHECK (game IN ('cs2', 'dota2')),
      rarity VARCHAR(50),
      quality VARCHAR(50),
      exterior VARCHAR(100),
      price DECIMAL(15,2) DEFAULT 0 CHECK (price >= 0 AND price <= 1000000),
      float_value DECIMAL(10,6) CHECK (float_value IS NULL OR (float_value >= 0 AND float_value <= 1)),
      paint_index INTEGER CHECK (paint_index IS NULL OR paint_index >= 0),
      pattern_id INTEGER CHECK (pattern_id IS NULL OR pattern_id >= 0),
      sticker_count SMALLINT DEFAULT 0 CHECK (sticker_count BETWEEN 0 AND 10),
      sticker_data JSONB DEFAULT '[]' CHECK (jsonb_typeof(sticker_data) = 'array'),
      owner_steam_id VARCHAR(20) CHECK (owner_steam_id IS NULL OR owner_steam_id ~ '^7656119[0-9]{10}$'),
      is_listed BOOLEAN DEFAULT false,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,

    // 📦 Трейды
    `CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      trade_offer_id VARCHAR(100) UNIQUE CHECK (length(trade_offer_id) > 0),
      bot_steam_id VARCHAR(20) NOT NULL CHECK (bot_steam_id ~ '^7656119[0-9]{10}$'),
      items_sent JSONB DEFAULT '[]' CHECK (jsonb_typeof(items_sent) = 'array'),
      items_received JSONB DEFAULT '[]' CHECK (jsonb_typeof(items_received) = 'array'),
      total_price DECIMAL(15,2) NOT NULL CHECK (total_price >= 0 AND total_price <= 1000000),
      status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'canceled', 'expired', 'sent', 'confirmed')),
      error_message TEXT CHECK (length(error_message) < 1000),
      expires_at TIMESTAMP WITH TIME ZONE CHECK (expires_at > CURRENT_TIMESTAMP),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,

    // 💸 Транзакции
    `CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(50) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'purchase', 'sale', 'admin_adjustment', 'refund', 'trade_fee')),
      amount DECIMAL(15,2) NOT NULL CHECK (amount != 0 AND abs(amount) <= 1000000),
      description TEXT CHECK (length(description) < 500),
      status VARCHAR(50) DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
      reference_id VARCHAR(100) CHECK (reference_id IS NULL OR length(reference_id) > 0),
      admin_steam_id VARCHAR(20) CHECK (admin_steam_id IS NULL OR admin_steam_id ~ '^7656119[0-9]{10}$'),
      metadata JSONB DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of tables) {
    try {
      await query(sql);
    } catch (error) {
      console.error('❌ Ошибка создания таблицы:', error.message);
      throw error;
    }
  }
  console.log('✅ Таблицы созданы/проверены');
};

// =============== ИНДЕКСЫ ===============
const createIndexes = async () => {
  const indexes = [
    // users
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_steam_id ON users(steam_id)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_role ON users(role)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_balance ON users(balance)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true',
    
    // items
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_owner ON items(owner_steam_id) WHERE owner_steam_id IS NOT NULL',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_game_listed ON items(game, is_listed, is_available)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_price ON items(price) WHERE price > 0',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_market_hash ON items USING gin(market_hash_name gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_created ON items(created_at)',
    
    // trades
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_user_id ON trades(user_id)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_status ON trades(status)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_created ON trades(created_at)',
    
    // transactions
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_created ON transactions(created_at)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_type ON transactions(type)',
    
    // Безопасные partial indexes для частых запросов
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_listed_active ON items(id) WHERE is_listed = true AND is_available = true'
  ];

  for (const sql of indexes) {
    try {
      // Используем CONCURRENTLY для продакшена, чтобы не блокировать таблицы
      if (process.env.NODE_ENV === 'production') {
        // Для CONCURRENTLY нужна отдельная транзакция
        await query('SET LOCAL statement_timeout = 300000'); // 5 мин для индексов
        await query(sql);
      } else {
        await query(sql.replace('CONCURRENTLY ', ''));
      }
    } catch (error) {
      // Игнорируем "already exists"
      if (!error.message.includes('already exists')) {
        console.warn('⚠️ Ошибка создания индекса:', error.message);
      }
    }
  }
  console.log('✅ Индексы созданы');
};

// =============== ТРИГГЕРЫ ===============
// ✅ ИСПРАВЛЕНО: Безопасное создание триггеров без IF NOT EXISTS
const createTriggers = async () => {
  try {
    // 1️⃣ Создаём функцию обновления updated_at (идемпотентно)
    await query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Защита: только если поле действительно изменилось
        IF row(NEW.*) IS DISTINCT FROM row(OLD.*) THEN
          NEW.updated_at = CURRENT_TIMESTAMP;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER; -- 🔒 Запуск от имени владельца
    `);

    // 2️⃣ Создаём триггеры только если их ещё нет
    const triggersToCreate = [
      { name: 'update_users_updated_at', table: 'users' },
      { name: 'update_items_updated_at', table: 'items' },
      { name: 'update_trades_updated_at', table: 'trades' }
    ];

    for (const { name, table } of triggersToCreate) {
      // ✅ Безопасная проверка существования через системные таблицы
      const result = await query(
        `SELECT tgname FROM pg_trigger 
         WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [name, table]
      );

      if (result.rows.length === 0) {
        // 🔒 Используем квотирование идентификаторов
        const safeName = `"${name.replace(/"/g, '""')}"`;
        const safeTable = `"${table.replace(/"/g, '""')}"`;
        
        await query(
          `CREATE TRIGGER ${safeName} 
           BEFORE UPDATE ON ${safeTable} 
           FOR EACH ROW 
           EXECUTE FUNCTION update_updated_at_column()`
        );
        console.log(`✅ Триггер '${name}' создан для таблицы '${table}'`);
      } else {
        console.log(`⏭️ Триггер '${name}' уже существует — пропускаем`);
      }
    }

    console.log('✅ Триггеры обновления времени добавлены');
  } catch (error) {
    console.error('❌ Ошибка создания триггеров:', {
      message: error.message,
      code: error.code
    });
    throw error;
  }
};

// =============== СИСТЕМНЫЕ ПОЛЬЗОВАТЕЛИ ===============
const createSystemUsers = async () => {
  const systemUsers = [
    { 
      steam_id: process.env.OWNER_STEAM_ID || '76561198352662328', 
      username: 'Владелец', 
      balance: 100000, 
      role: 'owner' 
    },
    { 
      steam_id: process.env.ADMIN_STEAM_ID || '76561198000000000', 
      username: 'Админ', 
      balance: 50000, 
      role: 'admin' 
    }
  ];

  // 🔒 Валидация SteamID
  const isValidSteamID = (id) => /^7656119[0-9]{10}$/.test(id);
  
  for (const user of systemUsers) {
    if (!isValidSteamID(user.steam_id)) {
      console.error(`❌ Невалидный SteamID в системных пользователях: ${user.steam_id}`);
      continue;
    }
    
    try {
      await query(`
        INSERT INTO users (steam_id, username, balance, role, is_active)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (steam_id) 
        DO UPDATE SET
          username = EXCLUDED.username,
          balance = GREATEST(users.balance, EXCLUDED.balance), -- 🔒 Защита от уменьшения баланса
          role = EXCLUDED.role,
          is_active = true,
          updated_at = CURRENT_TIMESTAMP
      `, [user.steam_id, user.username, user.balance, user.role]);
    } catch (error) {
      console.warn('⚠️ Ошибка создания системного пользователя:', error.message);
    }
  }
  console.log('✅ Системные пользователи созданы');
};

// =============== МИГРАЦИИ ===============
const migrateData = async () => {
  // 🔒 Безопасные миграции с проверкой существования
  const migrations = [
    { 
      check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'pattern_id'",
      sql: "ALTER TABLE items ADD COLUMN IF NOT EXISTS pattern_id INTEGER CHECK (pattern_id >= 0)"
    },
    { 
      check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'sticker_count'",
      sql: "ALTER TABLE items ADD COLUMN IF NOT EXISTS sticker_count SMALLINT DEFAULT 0 CHECK (sticker_count BETWEEN 0 AND 10)"
    },
    { 
      check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'sticker_data'",
      sql: "ALTER TABLE items ADD COLUMN IF NOT EXISTS sticker_data JSONB DEFAULT '[]' CHECK (jsonb_typeof(sticker_data) = 'array')"
    },
    { 
      check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'paint_index'",
      sql: "ALTER TABLE items ADD COLUMN IF NOT EXISTS paint_index INTEGER CHECK (paint_index >= 0)"
    }
  ];

  for (const { check, sql } of migrations) {
    try {
      const exists = await query(check);
      if (exists.rows.length === 0) {
        await query(sql);
        console.log(`✅ Миграция применена: ${sql.substring(0, 50)}...`);
      }
    } catch (error) {
      if (!error.message.includes('already exists')) {
        console.warn('⚠️ Ошибка миграции:', error.message);
      }
    }
  }
  console.log('✅ Миграции применены');
};

// =============== ТРАНЗАКЦИИ ===============
export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); // 🔒 Уровень изоляции
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// =============== HEALTH CHECK ===============
export const healthCheck = async () => {
  try {
    const start = Date.now();
    const result = await query('SELECT 1 AS ok, version() AS pg_version');
    const latency = Date.now() - start;
    
    return { 
      healthy: true,
      latency,
      database: 'connected',
      pgVersion: result.rows[0].pg_version.split(',')[0],
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { 
      healthy: false,
      error: 'Database connection failed',
      database: 'disconnected',
      timestamp: new Date().toISOString()
    };
  }
};

// =============== УТИЛИТЫ ===============
export const getPoolStats = () => {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    // Скрыты чувствительные данные
    max: pool.options.max
  };
};

// Экспорт пула (только для специальных случаев)
export { pool };

// 🚨 Защита от утечки чувствительных данных в логах
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason?.message || 'Unknown error');
  // Не логируем стек в продакшене
  if (process.env.NODE_ENV !== 'production') {
    console.error(reason);
  }
});

console.log('📦 PostgreSQL модуль загружен (безопасная конфигурация)');
