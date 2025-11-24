-- Создаем базу данных
CREATE DATABASE skinsale;

-- Подключаемся к базе
\c skinsale;

-- Таблица пользователей
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    steam_id VARCHAR(20) UNIQUE NOT NULL,
    username VARCHAR(100) NOT NULL,
    avatar VARCHAR(255),
    profile_url VARCHAR(255),
    balance DECIMAL(12,2) DEFAULT 0.00,
    trade_url VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица администраторов
CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    permissions JSONB DEFAULT '[]',
    added_by INTEGER REFERENCES users(id),
    is_owner BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица товаров
CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    game VARCHAR(50) NOT NULL,
    rarity VARCHAR(50),
    quality VARCHAR(50),
    price DECIMAL(12,2) NOT NULL,
    image_url VARCHAR(255),
    description TEXT,
    weapon_type VARCHAR(100),
    is_trending BOOLEAN DEFAULT false,
    is_available BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица транзакций
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    type VARCHAR(50) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'completed',
    admin_steam_id VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Индексы для скорости
CREATE INDEX idx_users_steam_id ON users(steam_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_items_game ON items(game);
CREATE INDEX idx_items_price ON items(price);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);

-- Вставляем владельца по умолчанию
INSERT INTO users (steam_id, username, avatar, balance, role) 
VALUES ('76561198352662328', 'Владелец', 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg', 100000, 'owner');

INSERT INTO admins (user_id, is_owner, added_by) 
VALUES (1, true, 1);
