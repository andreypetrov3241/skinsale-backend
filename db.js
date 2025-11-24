import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// Конфигурация пула соединений с улучшенными настройками
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Для Railway
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'skinsale',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  
  // Оптимизация для продакшена
  max: 20, // максимальное количество клиентов в пуле
  idleTimeoutMillis: 30000, // закрыть клиенты, которые бездействуют 30 секунд
  connectionTimeoutMillis: 2000, // вернуть ошибку через 2 секунды, если подключение не установлено
  maxUses: 7500, // закрыть (и заменить) клиент после 7500 запросов
});

// Обработка ошибок пула
pool.on('error', (err, client) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

pool.on('connect', () => {
  console.log('🔌 New database connection established');
});

pool.on('remove', () => {
  console.log('🔌 Database connection closed');
});

// Функция для безопасных запросов с логированием
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Логируем только медленные запросы в продакшене
    if (process.env.NODE_ENV === 'development' || duration > 100) {
      console.log(`📊 Executed query: ${text}`, { 
        duration: `${duration}ms`,
        rows: result.rowCount 
      });
    }
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`❌ Query failed after ${duration}ms:`, { 
      query: text,
      params: params,
      error: error.message 
    });
    throw error;
  }
};

// Функция для транзакций
export const transaction = async (callback) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
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

// Функция для инициализации базы с созданием таблиц
export const initDB = async () => {
  try {
    // Проверяем соединение
    const result = await pool.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('✅ PostgreSQL подключена успешно');
    console.log(`🕒 Время сервера: ${result.rows[0].current_time}`);
    console.log(`🗄️  Версия PostgreSQL: ${result.rows[0].postgres_version.split(',')[0]}`);
    
    // Создаем таблицы если их нет
    await createTables();
    
    // Создаем системных пользователей
    await createSystemUsers();
    
    console.log('🎯 База данных инициализирована успешно');
    
  } catch (error) {
    console.error('❌ Ошибка инициализации базы данных:', error.message);
    
    // В продакшене пытаемся переподключиться
    if (process.env.NODE_ENV === 'production') {
      console.log('🔄 Попытка переподключения через 5 секунд...');
      setTimeout(initDB, 5000);
    } else {
      process.exit(1);
    }
  }
};

// Создание таблиц
const createTables = async () => {
  const tables = [
    // Таблица пользователей
    `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      steam_id VARCHAR(20) UNIQUE NOT NULL,
      username VARCHAR(100) NOT NULL,
      avatar TEXT,
      profile_url TEXT,
      balance DECIMAL(15,2) DEFAULT 0.00,
      role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
      is_active BOOLEAN DEFAULT true,
      trade_url TEXT,
      last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `,
    
    // Таблица предметов
    `
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      steam_asset_id VARCHAR(100) UNIQUE,
      market_hash_name VARCHAR(500) NOT NULL,
      name VARCHAR(500) NOT NULL,
      image_url TEXT,
      game VARCHAR(50) DEFAULT 'cs2' CHECK (game IN ('cs2', 'dota2')),
      rarity VARCHAR(100),
      quality VARCHAR(100),
      exterior VARCHAR(100),
      price DECIMAL(15,2),
      float_value DECIMAL(10,6),
      pattern_id INTEGER,
      sticker_data JSONB,
      owner_steam_id VARCHAR(20),
      is_listed BOOLEAN DEFAULT false,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_items_game (game),
      INDEX idx_items_price (price),
      INDEX idx_items_owner (owner_steam_id)
    )
    `,
    
    // Таблица трейдов
    `
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      trade_offer_id VARCHAR(100) UNIQUE,
      bot_steam_id VARCHAR(20),
      items_sent JSONB,
      items_received JSONB,
      total_price DECIMAL(15,2),
      status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'canceled', 'expired')),
      error_message TEXT,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_trades_user (user_id),
      INDEX idx_trades_status (status)
    )
    `,
    
    // Таблица транзакций
    `
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'purchase', 'sale', 'admin_adjustment', 'refund')),
      amount DECIMAL(15,2) NOT NULL,
      description TEXT,
      status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
      reference_id VARCHAR(100),
      admin_steam_id VARCHAR(20),
      metadata JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_transactions_user (user_id),
      INDEX idx_transactions_type (type),
      INDEX idx_transactions_status (status)
    )
    `,
    
    // Таблица для кеша Steam инвентарей
    `
    CREATE TABLE IF NOT EXISTS inventory_cache (
      id SERIAL PRIMARY KEY,
      steam_id VARCHAR(20) NOT NULL,
      app_id INTEGER NOT NULL,
      context_id INTEGER NOT NULL,
      items JSONB NOT NULL,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      UNIQUE(steam_id, app_id, context_id),
      INDEX idx_inventory_cache_steam (steam_id),
      INDEX idx_inventory_cache_expires (expires_at)
    )
    `,
    
    // Таблица настроек системы
    `
    CREATE TABLE IF NOT EXISTS system_settings (
      id SERIAL PRIMARY KEY,
      key VARCHAR(100) UNIQUE NOT NULL,
      value JSONB NOT NULL,
      description TEXT,
      updated_by VARCHAR(20),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  ];

  try {
    for (const tableSql of tables) {
      await query(tableSql);
    }
    console.log('✅ Все таблицы созданы/проверены успешно');
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error.message);
    throw error;
  }
};

// Создание системных пользователей
const createSystemUsers = async () => {
  const systemUsers = [
    {
      steam_id: '76561198352662328',
      username: 'Владелец системы',
      avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg',
      balance: 100000,
      role: 'owner'
    },
    {
      steam_id: '76561198000000000',
      username: 'Администратор',
      avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg',
      balance: 50000,
      role: 'admin'
    }
  ];

  try {
    for (const user of systemUsers) {
      await query(`
        INSERT INTO users (steam_id, username, avatar, balance, role) 
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (steam_id) 
        DO UPDATE SET 
          username = EXCLUDED.username,
          avatar = EXCLUDED.avatar,
          balance = EXCLUDED.balance,
          role = EXCLUDED.role,
          updated_at = CURRENT_TIMESTAMP
      `, [user.steam_id, user.username, user.avatar, user.balance, user.role]);
    }
    console.log('✅ Системные пользователи созданы/обновлены');
  } catch (error) {
    console.error('❌ Ошибка создания системных пользователей:', error.message);
  }
};

// Функция для проверки здоровья базы данных
export const healthCheck = async () => {
  try {
    const result = await query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as users_count,
        (SELECT COUNT(*) FROM items WHERE is_available = true) as active_items,
        (SELECT COUNT(*) FROM trades WHERE status = 'pending') as pending_trades,
        (SELECT SUM(balance) FROM users) as total_balance,
        NOW() as check_time
    `);
    
    return {
      status: 'healthy',
      ...result.rows[0],
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Завершение работы базы данных...');
  await pool.end();
  console.log('✅ Пул соединений закрыт');
  process.exit(0);
});

export default pool;
