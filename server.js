import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { query, initDB } from './db.js';
import { steamService } from './services/steamService.js';

dotenv.config();
await initDB();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Middleware безопасности
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Лимит запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Валидация Steam ID
const validateSteamId = (steamId) => {
  return /^7656119\d{10}$/.test(steamId);
};

// Генерация JWT токена
const generateToken = (user) => {
  return jwt.sign(
    { 
      steamId: user.steam_id,
      role: user.role,
      id: user.id
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};

// Middleware для проверки аутентификации
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Токен доступа отсутствует' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const userResult = await query(
      'SELECT * FROM users WHERE steam_id = $1 AND is_active = true',
      [decoded.steamId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден или заблокирован' });
    }
    
    req.user = userResult.rows[0];
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Неверный токен' });
  }
};

// Middleware для проверки админских прав
const requireAdmin = async (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
};

// Middleware для проверки прав владельца
const requireOwner = async (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Требуются права владельца' });
  }
  next();
};

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ==================== AUTH ROUTES ====================

// Авторизация через Steam
app.post('/api/auth/steam', async (req, res) => {
  try {
    const { steamData } = req.body;
    
    if (!steamData || !validateSteamId(steamData.steamid)) {
      return res.status(400).json({ error: 'Неверные данные Steam' });
    }

    // Ищем пользователя в базе
    const userResult = await query(
      'SELECT * FROM users WHERE steam_id = $1',
      [steamData.steamid]
    );

    let user;
    
    if (userResult.rows.length === 0) {
      // Автоматическая регистрация
      const newUserResult = await query(
        `INSERT INTO users (steam_id, username, avatar, profile_url, balance) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [
          steamData.steamid,
          steamData.personaname || 'Steam User',
          steamData.avatar,
          steamData.profileurl,
          5000
        ]
      );
      user = newUserResult.rows[0];
    } else {
      user = userResult.rows[0];
      
      // Обновляем данные если нужно
      if (user.username !== steamData.personaname || user.avatar !== steamData.avatar) {
        await query(
          'UPDATE users SET username = $1, avatar = $2, profile_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [steamData.personaname, steamData.avatar, steamData.profileurl, user.id]
        );
        user.username = steamData.personaname;
        user.avatar = steamData.avatar;
      }
    }

    const token = generateToken(user);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        steamId: user.steam_id,
        username: user.username,
        avatar: user.avatar,
        balance: parseFloat(user.balance),
        role: user.role,
        isActive: user.is_active
      }
    });

  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Ошибка сервера при авторизации' });
  }
});

// Получить профиль пользователя
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      steamId: req.user.steam_id,
      username: req.user.username,
      avatar: req.user.avatar,
      balance: parseFloat(req.user.balance),
      role: req.user.role,
      isActive: req.user.is_active
    }
  });
});

// ==================== STEAM INVENTORY ROUTES ====================

// Получить инвентарь пользователя
app.get('/api/steam/inventory/:steamId', authenticateToken, async (req, res) => {
  try {
    const { steamId } = req.params;
    const { appid = '730' } = req.query;

    if (!validateSteamId(steamId)) {
      return res.status(400).json({ error: 'Неверный Steam ID' });
    }

    // Проверяем что пользователь запрашивает свой инвентарь
    if (req.user.steam_id !== steamId && req.user.role === 'user') {
      return res.status(403).json({ error: 'Нет доступа к этому инвентарю' });
    }

    const inventory = await steamService.getUserInventory(steamId, parseInt(appid));
    
    res.json({
      success: true,
      items: inventory,
      total: inventory.length,
      game: appid === '730' ? 'CS2' : 'Dota2'
    });

  } catch (error) {
    console.error('Inventory API error:', error);
    res.status(500).json({ 
      error: error.message || 'Ошибка получения инвентаря' 
    });
  }
});

// Получить инвентарь текущего пользователя
app.get('/api/steam/my-inventory', authenticateToken, async (req, res) => {
  try {
    const { appid = '730' } = req.query;
    
    const inventory = await steamService.getUserInventory(req.user.steam_id, parseInt(appid));
    
    res.json({
      success: true,
      items: inventory,
      total: inventory.length,
      game: appid === '730' ? 'CS2' : 'Dota2'
    });

  } catch (error) {
    console.error('My inventory API error:', error);
    res.status(500).json({ 
      error: error.message || 'Ошибка получения вашего инвентаря' 
    });
  }
});

// ==================== TRADE ROUTES ====================

// Создать трейд оффер
app.post('/api/steam/trade', authenticateToken, async (req, res) => {
  try {
    const { itemsToSell, itemsToBuy, totalPrice } = req.body;
    
    if (!itemsToSell || !Array.isArray(itemsToSell)) {
      return res.status(400).json({ error: 'Не указаны предметы для продажи' });
    }

    // Проверяем баланс пользователя
    if (req.user.balance < totalPrice) {
      return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    }

    // Создаем трейд оффер
    const tradeResult = await steamService.createTradeOffer(
      req.user.steam_id,
      process.env.BOT_STEAM_ID,
      itemsToSell,
      itemsToBuy
    );

    // Сохраняем трейд в базу
    const tradeDbResult = await query(
      `INSERT INTO trades (user_id, trade_offer_id, items_sent, items_received, total_price, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.user.id,
        tradeResult.tradeOfferId,
        JSON.stringify(itemsToSell),
        JSON.stringify(itemsToBuy),
        totalPrice,
        'pending'
      ]
    );

    res.json({
      success: true,
      trade: tradeDbResult.rows[0],
      message: 'Трейд оффер создан успешно'
    });

  } catch (error) {
    console.error('Trade API error:', error);
    res.status(500).json({ 
      error: error.message || 'Ошибка создания трейда' 
    });
  }
});

// Получить историю трейдов пользователя
app.get('/api/steam/trades', authenticateToken, async (req, res) => {
  try {
    const tradesResult = await query(
      `SELECT * FROM trades 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [req.user.id]
    );
    
    res.json({
      success: true,
      trades: tradesResult.rows
    });
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({ error: 'Ошибка получения истории трейдов' });
  }
});

// ==================== ITEMS ROUTES ====================

// Получить предметы доступные для покупки
app.get('/api/items/market', async (req, res) => {
  try {
    const { game = 'cs2', page = 1, limit = 20 } = req.query;
    
    const offset = (page - 1) * limit;
    
    const itemsResult = await query(
      `SELECT * FROM items 
       WHERE game = $1 AND is_listed = true AND is_available = true
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [game, limit, offset]
    );
    
    const countResult = await query(
      `SELECT COUNT(*) FROM items 
       WHERE game = $1 AND is_listed = true AND is_available = true`,
      [game]
    );
    
    res.json({
      success: true,
      items: itemsResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Market items error:', error);
    res.status(500).json({ error: 'Ошибка получения предметов маркета' });
  }
});

// Выставить предмет на продажу
app.post('/api/items/sell', authenticateToken, async (req, res) => {
  try {
    const { items, prices } = req.body;
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Не указаны предметы для продажи' });
    }

    // Сохраняем предметы в базу как доступные для продажи
    for (const item of items) {
      await query(
        `INSERT INTO items (
          steam_asset_id, market_hash_name, name, image_url, game, 
          rarity, quality, exterior, price, owner_steam_id, is_listed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (steam_asset_id) 
        DO UPDATE SET 
          price = $9, is_listed = $11, updated_at = CURRENT_TIMESTAMP`,
        [
          item.steam_id,
          item.market_hash_name,
          item.name,
          item.image_url,
          item.game,
          item.rarity,
          item.quality,
          item.exterior,
          prices[item.steam_id] || item.price,
          req.user.steam_id,
          true
        ]
      );
    }

    res.json({
      success: true,
      message: `Предметы успешно выставлены на продажу`
    });

  } catch (error) {
    console.error('Sell items error:', error);
    res.status(500).json({ error: 'Ошибка при выставлении предметов на продажу' });
  }
});

// ==================== BALANCE ROUTES ====================

// Пополнить баланс
app.post('/api/user/deposit', authenticateToken, async (req, res) => {
  try {
    const { amount, paymentMethod } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Неверная сумма пополнения' });
    }

    // Обновляем баланс пользователя
    const newBalance = parseFloat(req.user.balance) + parseFloat(amount);
    
    await query(
      'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newBalance, req.user.id]
    );

    // Логируем транзакцию
    await query(
      `INSERT INTO transactions (user_id, type, amount, description, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'deposit',
        parseFloat(amount),
        `Пополнение через ${paymentMethod || 'неизвестный метод'}`,
        'completed'
      ]
    );

    res.json({
      success: true,
      newBalance,
      message: 'Баланс успешно пополнен'
    });

  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Ошибка при пополнении баланса' });
  }
});

// Вывести средства
app.post('/api/user/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Неверная сумма вывода' });
    }

    if (parseFloat(req.user.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    }

    // Обновляем баланс пользователя
    const newBalance = parseFloat(req.user.balance) - parseFloat(amount);
    
    await query(
      'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newBalance, req.user.id]
    );

    // Логируем транзакцию
    await query(
      `INSERT INTO transactions (user_id, type, amount, description, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'withdrawal',
        -parseFloat(amount),
        'Вывод средств',
        'completed'
      ]
    );

    res.json({
      success: true,
      newBalance,
      message: 'Запрос на вывод средств принят'
    });

  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Ошибка при выводе средств' });
  }
});

// ==================== ADMIN ROUTES ====================

// Получить всех пользователей
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersResult = await query(
      'SELECT id, steam_id, username, avatar, balance, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    
    const users = usersResult.rows.map(user => ({
      id: user.id,
      steamId: user.steam_id,
      username: user.username,
      avatar: user.avatar,
      balance: parseFloat(user.balance),
      role: user.role,
      isActive: user.is_active,
      createdAt: user.created_at
    }));
    
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Ошибка при получении пользователей' });
  }
});

// Получить статистику
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersCount = await query('SELECT COUNT(*) FROM users');
    const adminsCount = await query('SELECT COUNT(*) FROM users WHERE role IN ($1, $2)', ['admin', 'owner']);
    const itemsCount = await query('SELECT COUNT(*) FROM items WHERE is_available = true');
    const totalBalance = await query('SELECT SUM(balance) as total FROM users');
    const transactionsCount = await query('SELECT COUNT(*) FROM transactions WHERE status = $1', ['pending']);

    res.json({
      totalUsers: parseInt(usersCount.rows[0].count),
      totalAdmins: parseInt(adminsCount.rows[0].count),
      totalItems: parseInt(itemsCount.rows[0].count),
      totalBalance: parseFloat(totalBalance.rows[0].total) || 0,
      activeTransactions: parseInt(transactionsCount.rows[0].count)
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Ошибка при получении статистики' });
  }
});

// Обновить баланс пользователя
app.put('/api/admin/users/:steamId/balance', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { steamId } = req.params;
    const { balance, reason } = req.body;

    if (!balance || isNaN(balance)) {
      return res.status(400).json({ error: 'Неверная сумма' });
    }

    // Получаем пользователя
    const userResult = await query(
      'SELECT id, balance FROM users WHERE steam_id = $1',
      [steamId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const userId = userResult.rows[0].id;
    const oldBalance = parseFloat(userResult.rows[0].balance);

    // Обновляем баланс
    await query(
      'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [parseFloat(balance), userId]
    );

    // Логируем транзакцию
    await query(
      `INSERT INTO transactions (user_id, type, amount, description, admin_steam_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'admin_adjustment', parseFloat(balance) - oldBalance, reason || 'Корректировка баланса администратором', req.user.steam_id]
    );

    // Возвращаем обновленного пользователя
    const updatedUserResult = await query(
      'SELECT id, steam_id, username, avatar, balance, role, is_active FROM users WHERE id = $1',
      [userId]
    );

    res.json({ 
      success: true, 
      user: {
        ...updatedUserResult.rows[0],
        steamId: updatedUserResult.rows[0].steam_id,
        balance: parseFloat(updatedUserResult.rows[0].balance)
      }
    });

  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: error.message || 'Ошибка при обновлении баланса' });
  }
});

// ==================== OWNER ROUTES ====================

// Получить всех админов
app.get('/api/owner/admins', authenticateToken, requireOwner, async (req, res) => {
  try {
    const adminsResult = await query(
      'SELECT u.id, u.steam_id, u.username, u.avatar, u.role, u.created_at FROM users u WHERE u.role IN ($1, $2) ORDER BY u.created_at DESC',
      ['admin', 'owner']
    );
    
    res.json(adminsResult.rows);
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({ error: 'Ошибка при получении списка администраторов' });
  }
});

// Добавить админа
app.post('/api/owner/admins', authenticateToken, requireOwner, async (req, res) => {
  try {
    const { steamId } = req.body;

    if (!validateSteamId(steamId)) {
      return res.status(400).json({ error: 'Неверный Steam ID' });
    }

    // Находим пользователя
    const userResult = await query(
      'SELECT id FROM users WHERE steam_id = $1',
      [steamId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const userId = userResult.rows[0].id;

    // Проверяем не является ли уже админом
    const adminCheck = await query(
      'SELECT role FROM users WHERE id = $1',
      [userId]
    );

    if (adminCheck.rows[0].role === 'admin' || adminCheck.rows[0].role === 'owner') {
      return res.status(400).json({ error: 'Пользователь уже является администратором' });
    }

    // Обновляем роль пользователя
    await query(
      'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['admin', userId]
    );

    res.json({ success: true, message: 'Пользователь назначен администратором' });

  } catch (error) {
    console.error('Add admin error:', error);
    res.status(500).json({ error: 'Ошибка при добавлении администратора' });
  }
});

// Удалить админа
app.delete('/api/owner/admins/:steamId', authenticateToken, requireOwner, async (req, res) => {
  try {
    const { steamId } = req.params;

    if (!validateSteamId(steamId)) {
      return res.status(400).json({ error: 'Неверный Steam ID' });
    }

    // Нельзя удалить самого себя
    if (steamId === req.user.steam_id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }

    // Обновляем роль пользователя на user
    await query(
      'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE steam_id = $2',
      ['user', steamId]
    );

    res.json({ success: true, message: 'Права администратора удалены' });

  } catch (error) {
    console.error('Remove admin error:', error);
    res.status(500).json({ error: 'Ошибка при удалении администратора' });
  }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Защищенный сервер запущен на порту ${PORT}`);
  console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Установлен' : 'Используется по умолчанию (замените в продакшене!)'}`);
  console.log(`🗄️  База данных: PostgreSQL`);
  console.log(`🎮 Steam API: ${process.env.STEAM_API_KEY ? 'Настроен' : 'НЕ НАСТРОЕН!'}`);
  console.log(`🤖 Bot Steam ID: ${process.env.BOT_STEAM_ID || 'НЕ НАСТРОЕН!'}`);
});
