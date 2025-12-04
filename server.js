// server.js — ПОЛНАЯ ИСПРАВЛЕННАЯ ВЕРСИЯ
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import { query, initDB } from './db.js';
import { steamService } from './services/steamService.js';
import { steamAuth } from './services/steamAuth.js';
import { makePaymentRequest, paymentUtils } from './services/paymentProxy.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

// 🔧 ВАЖНО ДЛЯ ПРОКСИ
app.set('trust proxy', true);

// 🔑 Секреты из .env
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;

// ✅ URL из .env
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://skinssale.kz';
const BACKEND_URL = process.env.BACKEND_URL || 'https://backanedservaksale-production.up.railway.app';

console.log('🌐 Frontend URL (на Beget):', FRONTEND_URL);
console.log('🔧 Backend URL:', BACKEND_URL);
console.log('🔒 NODE_ENV:', process.env.NODE_ENV);

// ==================== 🛡️ БЕЗОПАСНОСТЬ ====================
app.use(hpp());
app.use(mongoSanitize());

// 🔐 CSP
const cspDirectives = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
  scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
  connectSrc: [
    "'self'",
    FRONTEND_URL,
    BACKEND_URL,
    "https://api.steampowered.com",
    "https://steamcommunity.com",
    "https://steamcommunity-a.akamaihd.net",
    "https://community.akamai.steamstatic.com",
    "https://community.cloudflare.steamstatic.com",
    "https://api.paymtech.kz",
    "https://sandboxapi.paymtech.kz",
    "https://sandboxmerch.paymtech.kz"
  ],
  imgSrc: [
    "'self'", 
    "data:", 
    "blob:",
    "https:", 
    "http:",
    FRONTEND_URL,
    "https://steamcommunity-a.akamaihd.net",
    "https://cdn.steamcommunity.com",
    "https://community.akamai.steamstatic.com",
    "https://community.cloudflare.steamstatic.com",
    "https://cdn.cloudflare.steamstatic.com",
    "https://steamcommunity.com",
    "https://cdn2.csgo.com"
  ],
  frameSrc: ["https://steamcommunity.com", "https://sandboxmerch.paymtech.kz"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  formAction: ["'self'", "https://steamcommunity.com", "https://sandboxmerch.paymtech.kz"]
};

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 🌐 CORS
const corsOptions = {
  origin: function (origin, callback) {
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'http://skinssale.kz',
      'https://skinssale.kz',
      'http://www.skinssale.kz',
      'https://www.skinssale.kz',
      'https://backanedservaksale-production.up.railway.app',
      'https://api.skinsale.kz',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://localhost:5000',
      'http://192.168.1.*:*',
      'http://10.*.*.*:*',
      FRONTEND_URL,
      FRONTEND_URL.replace('https://', 'http://'),
      FRONTEND_URL.replace('http://', 'https://'),
      `http://${FRONTEND_URL.replace('https://', '').replace('http://', '').replace('www.', '')}`,
      `https://www.${FRONTEND_URL.replace('https://', '').replace('http://', '').replace('www.', '')}`,
      'null'
    ];
    
    const allowed = [...new Set(allowedOrigins.filter(Boolean).map(u => u.trim().replace(/\/+$/, '')))];
    
    if (!origin) {
      return callback(null, true);
    }
    
    const originMatches = allowed.some(allowedOrigin => {
      if (allowedOrigin.includes('*')) {
        const regex = new RegExp('^' + allowedOrigin.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return regex.test(origin);
      }
      return origin === allowedOrigin;
    });
    
    if (originMatches) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'Cookie', 
    'X-Requested-With', 
    'Origin', 
    'Accept',
    'x-access-token',
    'x-refresh-token',
    'X-CSRF-Token'
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range', 'X-Total-Count'],
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(cookieParser(SESSION_SECRET));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 🔍 Middleware для логирования запросов
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  const accessToken = req.cookies.accessToken;
  
  if (authHeader || accessToken) {
    console.log(`🔐 ${req.method} ${req.path} - Авторизация: ${authHeader ? 'Header' : 'Cookie'} token present - IP: ${req.ip}`);
  } else {
    console.log(`🔓 ${req.method} ${req.path} - Без авторизации - Origin: ${req.headers.origin || 'no-origin'} - IP: ${req.ip}`);
  }
  next();
});

// ⏱️ Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Слишком много запросов', code: 'RATE_LIMITED' },
  skip: (req) => req.path === '/health',
  keyGenerator: (req) => `${req.ip}-${req.get('user-agent')}`
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Слишком много платежных запросов', code: 'PAYMENT_RATE_LIMITED' },
  keyGenerator: (req) => `${req.ip}-${req.get('user-agent')}`
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Слишком много запросов к админке', code: 'ADMIN_RATE_LIMITED' },
  keyGenerator: (req) => `${req.ip}-${req.get('user-agent')}`
});

app.use('/api/', generalLimiter);
app.use('/api/payments/', paymentLimiter);
app.use('/api/admin/', adminLimiter);

// ==================== 🎯 ВАЛИДАЦИЯ ====================
const validateSteamId = (steamId) => /^7656119\d{10}$/.test(steamId);

// ==================== 🔐 УТИЛИТЫ ====================
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { steamId: user.steam_id, role: user.role, id: user.id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  const refreshToken = jwt.sign(
    { steamId: user.steam_id, id: user.id },
    JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken };
};

const authenticateToken = async (req, res, next) => {
  try {
    let token = req.cookies.accessToken;
    
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else {
        token = authHeader;
      }
    }
    
    if (!token && req.headers['x-access-token']) {
      token = req.headers['x-access-token'];
    }
    
    console.log(`🔍 Проверка токена: ${token ? 'Присутствует' : 'Отсутствует'}`);
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Токен отсутствует', 
        code: 'TOKEN_MISSING',
        message: 'Пожалуйста, войдите в систему'
      });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log(`🔍 Декодированный токен для Steam ID: ${decoded.steamId}`);
    
    const userResult = await query(
      'SELECT id, steam_id, username, avatar, balance, role, is_active FROM users WHERE steam_id = $1 AND is_active = true',
      [decoded.steamId]
    );
    
    if (userResult.rows.length === 0) {
      console.log(`❌ Пользователь не найден или не активен: ${decoded.steamId}`);
      return res.status(401).json({ 
        error: 'Пользователь не найден или не активен', 
        code: 'USER_NOT_FOUND',
        message: 'Ваш аккаунт не найден или заблокирован'
      });
    }
    
    req.user = userResult.rows[0];
    console.log(`✅ Авторизация успешна: ${req.user.username} (${req.user.role})`);
    next();
  } catch (error) {
    console.error('❌ Ошибка аутентификации:', error.message);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Токен истек', 
        code: 'TOKEN_EXPIRED',
        message: 'Ваша сессия истекла, войдите снова'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ 
        error: 'Неверный токен', 
        code: 'INVALID_TOKEN',
        message: 'Недействительный токен авторизации'
      });
    }
    
    return res.status(403).json({ 
      error: 'Ошибка аутентификации', 
      code: 'AUTH_ERROR',
      message: error.message
    });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') {
    console.log(`🚫 Недостаточно прав: ${req.user.username} имеет роль ${req.user.role}`);
    return res.status(403).json({ 
      error: 'Требуются права администратора', 
      code: 'FORBIDDEN',
      message: 'У вас нет прав доступа к административной панели'
    });
  }
  console.log(`👑 Доступ к админке разрешен: ${req.user.username} (${req.user.role})`);
  next();
};

const requireOwner = (req, res, next) => {
  if (req.user.role !== 'owner') {
    console.log(`🚫 Недостаточно прав владельца: ${req.user.username} имеет роль ${req.user.role}`);
    return res.status(403).json({ 
      error: 'Требуются права владельца', 
      code: 'FORBIDDEN_OWNER',
      message: 'Только владелец имеет доступ к этому разделу'
    });
  }
  console.log(`👑 Доступ владельца разрешен: ${req.user.username}`);
  next();
};

// ==================== 💰 БАЛАНС И ПЛАТЕЖИ ====================
// 💵 ПОПОЛНЕНИЕ БАЛАНСА
app.post('/api/payments/deposit', authenticateToken, async (req, res) => {
  try {
    const { amount, currency = 'USD' } = req.body;
    if (!amount || amount < 1) {
      return res.status(400).json({ 
        error: 'Минимальная сумма 1 USD', 
        code: 'INVALID_AMOUNT' 
      });
    }
    console.log(`💰 Создание заказа на ${amount} ${currency} для пользователя ${req.user.steam_id}`);
    const result = await makePaymentRequest({
      method: 'POST',
      path: '/orders/create'
    }, JSON.stringify({
      amount: parseFloat(amount),
      currency: currency,
      description: `Deposit for user ${req.user.steam_id}`,
      merchant_order_id: paymentUtils.generateOrderId(req.user.id, 'deposit'),
      client: {
        email: req.user.email || `${req.user.steam_id}@steam.com`,
        name: req.user.username || 'Steam User'
      },
      options: {
        return_url: `${FRONTEND_URL}/payment/success`,
        expiration_timeout: '30m'
      }
    }));

    if (result.statusCode === 201 || result.statusCode === 200) {
      const order = result.data.orders?.[0];
      if (!order) {
        throw new Error('No order data in response');
      }

      await query(
        `INSERT INTO payments (user_id, order_id, amount, currency, status, type) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.id, order.id, amount, currency, 'pending', 'deposit']
      );

      let paymentUrl = result.data.payment_url || result.headers?.location || `https://sandboxmerch.paymtech.kz/v2/pay/${order.id}`;

      console.log(`🔗 Платежная ссылка: ${paymentUrl}`);
      res.json({
        success: true,
        orderId: order.id,
        paymentUrl: paymentUrl,
        amount: amount,
        currency: currency,
        message: 'Order created successfully'
      });
    } else {
      throw new Error(result.data.failure_message || `Payment creation failed with status ${result.statusCode}`);
    }
  } catch (error) {
    console.error('❌ Deposit error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка создания платежа',
      message: error.message,
      code: 'DEPOSIT_ERROR' 
    });
  }
});

// 🔄 СОВМЕСТИМОСТЬ СО СТАРЫМ ФРОНТЕНДОМ
app.post('/api/payments/create', authenticateToken, async (req, res) => {
  try {
    const { amount, currency = 'USD' } = req.body;
    if (!amount || amount < 1) {
      return res.status(400).json({ 
        error: 'Минимальная сумма 1 USD', 
        code: 'INVALID_AMOUNT' 
      });
    }
    console.log(`💰 [LEGACY] Создание заказа на ${amount} ${currency} для пользователя ${req.user.steam_id}`);
    const result = await makePaymentRequest({
      method: 'POST',
      path: '/orders/create'
    }, JSON.stringify({
      amount: parseFloat(amount),
      currency: currency,
      description: `Deposit for user ${req.user.steam_id}`,
      merchant_order_id: paymentUtils.generateOrderId(req.user.id, 'deposit'),
      client: {
        email: req.user.email || `${req.user.steam_id}@steam.com`,
        name: req.user.username || 'Steam User'
      },
      options: {
        return_url: `${FRONTEND_URL}/payment/success`,
        expiration_timeout: '30m'
      }
    }));

    if (result.statusCode === 201 || result.statusCode === 200) {
      const order = result.data.orders?.[0];
      if (!order) {
        throw new Error('No order data in response');
      }

      await query(
        `INSERT INTO payments (user_id, order_id, amount, currency, status, type) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.id, order.id, amount, currency, 'pending', 'deposit']
      );

      let paymentUrl = result.data.payment_url || result.headers?.location || `https://sandboxmerch.paymtech.kz/v2/pay/${order.id}`;

      res.json({
        success: true,
        orderId: order.id,
        paymentUrl: paymentUrl,
        amount: amount,
        currency: currency,
        message: 'Order created successfully'
      });
    } else {
      throw new Error(result.data.failure_message || `Payment creation failed with status ${result.statusCode}`);
    }
  } catch (error) {
    console.error('❌ Legacy payment error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка создания платежа',
      message: error.message,
      code: 'DEPOSIT_ERROR' 
    });
  }
});

// 💸 ВЫВОД СРЕДСТВ
app.post('/api/payments/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, payment_method, wallet_number } = req.body;
    if (!amount || amount < 1) {
      return res.status(400).json({ 
        error: 'Минимальная сумма 1 USD', 
        code: 'INVALID_AMOUNT' 
      });
    }

    const userResult = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const currentBalance = parseFloat(userResult.rows[0].balance);
    if (currentBalance < amount) {
      return res.status(400).json({ 
        error: 'Недостаточно средств на балансе', 
        code: 'INSUFFICIENT_FUNDS' 
      });
    }

    console.log(`💸 Запрос на вывод ${amount} USD от пользователя ${req.user.steam_id}`);

    await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);

    const withdrawResult = await query(
      `INSERT INTO payments (user_id, order_id, amount, currency, status, type, payment_method, wallet_number) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.user.id, 
        paymentUtils.generateOrderId(req.user.id, 'withdraw'),
        amount, 
        'USD', 
        'processing', 
        'withdraw',
        payment_method,
        wallet_number
      ]
    );

    const updatedUserResult = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const newBalance = parseFloat(updatedUserResult.rows[0].balance);

    res.json({
      success: true,
      message: 'Запрос на вывод средств принят в обработку',
      withdrawId: withdrawResult.rows[0].id,
      amount: amount,
      newBalance: newBalance,
      status: 'processing'
    });
  } catch (error) {
    console.error('❌ Withdraw error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка при выводе средств',
      message: error.message,
      code: 'WITHDRAW_ERROR' 
    });
  }
});

// 🔍 ПРОВЕРКА СТАТУСА ПЛАТЕЖА
app.get('/api/payments/status/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log(`🔍 Проверка статуса платежа: ${orderId}`);

    const paymentResult = await query(
      'SELECT * FROM payments WHERE order_id = $1 AND user_id = $2',
      [orderId, req.user.id]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Платеж не найден',
        code: 'PAYMENT_NOT_FOUND'
      });
    }

    const payment = paymentResult.rows[0];
    if (payment.type === 'deposit' && payment.status === 'pending') {
      const result = await makePaymentRequest({ method: 'GET', path: `/orders/${orderId}` });
      if (result.statusCode === 200) {
        const order = result.data.orders?.[0];
        if (order) {
          await query('UPDATE payments SET status = $1 WHERE order_id = $2', [order.status, orderId]);
          if (paymentUtils.isSuccessStatus(order.status)) {
            await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payment.amount, req.user.id]);
            await query('UPDATE payments SET status = $1 WHERE order_id = $2', ['completed', orderId]);
            console.log(`✅ Средства зачислены: ${payment.amount} ${payment.currency} пользователю ${req.user.steam_id}`);
          }
        }
      }
    }

    const updatedPaymentResult = await query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    const updatedPayment = updatedPaymentResult.rows[0];
    const userResult = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const currentBalance = parseFloat(userResult.rows[0].balance);

    res.json({
      success: true,
      payment: updatedPayment,
      currentBalance: currentBalance,
      message: 'Payment status checked'
    });
  } catch (error) {
    console.error('❌ Payment status error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка проверки статуса платежа',
      code: 'STATUS_CHECK_ERROR' 
    });
  }
});

// 💰 ПОЛУЧЕНИЕ ТЕКУЩЕГО БАЛАНСА
app.get('/api/user/balance', authenticateToken, async (req, res) => {
  try {
    const userResult = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userResult.rows[0].balance);
    res.json({ 
      success: true, 
      balance: balance,
      currency: 'USD'
    });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ 
      error: 'Ошибка получения баланса', 
      code: 'BALANCE_ERROR' 
    });
  }
});

// 📋 ИСТОРИЯ ПЛАТЕЖЕЙ
app.get('/api/payments/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 10, page = 1, type } = req.query;
    const offset = (page - 1) * limit;
    let queryText = `
      SELECT id, order_id, amount, currency, status, type, payment_method, wallet_number, created_at, updated_at 
      FROM payments 
      WHERE user_id = $1 
    `;
    let queryParams = [req.user.id];
    if (type && (type === 'deposit' || type === 'withdraw')) {
      queryText += ' AND type = $2 ';
      queryParams.push(type);
    }
    queryText += ' ORDER BY created_at DESC LIMIT $' + (queryParams.length + 1) + ' OFFSET $' + (queryParams.length + 2);
    queryParams.push(limit, offset);
    const paymentsResult = await query(queryText, queryParams);
    const totalResult = await query(
      'SELECT COUNT(*) as total FROM payments WHERE user_id = $1' + (type ? ' AND type = $2' : ''),
      type ? [req.user.id, type] : [req.user.id]
    );
    const userResult = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const currentBalance = parseFloat(userResult.rows[0].balance);

    res.json({
      success: true,
      payments: paymentsResult.rows,
      currentBalance: currentBalance,
      total: parseInt(totalResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Payment history error:', error);
    res.status(500).json({ 
      error: 'Ошибка получения истории платежей',
      code: 'PAYMENT_HISTORY_ERROR' 
    });
  }
});

// 🧪 ТЕСТ ПЛАТЕЖНОЙ СИСТЕМЫ
app.get('/api/payments/test', async (req, res) => {
  try {
    const result = await makePaymentRequest({ method: 'GET', path: '/ping' });
    res.json({
      success: true,
      paymentGateway: 'Paymtech',
      status: result.statusCode === 200 ? 'connected' : 'error',
      response: result.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Payment test error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment gateway connection failed',
      message: error.message
    });
  }
});

// ==================== ✅ STEAM AUTH FLOW ====================
app.get('/api/auth/steam', (req, res) => {
  console.log('🔐 Запрос Steam аутентификации от:', req.ip);
  try {
    const steamUrl = steamAuth.getRedirectUrl();
    console.log('🔐 Редирект на Steam:', steamUrl);
    res.redirect(302, steamUrl);
  } catch (error) {
    console.error('❌ Ошибка Steam аутентификации:', error);
    res.status(500).json({ error: 'Ошибка инициации аутентификации', code: 'STEAM_INIT_ERROR' });
  }
});

app.get('/api/auth/steam/callback', async (req, res) => {
  try {
    console.log('🔐 Steam Callback получен через Apache прокси');
    console.log('📨 Query params:', req.query);
    let queryParams = { ...req.query };
    if (Object.keys(queryParams).length === 0) {
      const urlParts = req.url.split('?');
      if (urlParts.length > 1) {
        const searchParams = new URLSearchParams(urlParts[1]);
        searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
      }
    }
    if (!queryParams || Object.keys(queryParams).length === 0) {
      return res.redirect(`${FRONTEND_URL}/auth?status=error&message=no_parameters`);
    }

    let steamId = await steamAuth.verifyAssertion(queryParams);
    if (!steamId) {
      steamId = await steamAuth.verifyAssertionSimple(queryParams);
    }
    if (!steamId) {
      return res.redirect(`${FRONTEND_URL}/auth?status=error&message=auth_failed`);
    }

    console.log(`✅ Успешная аутентификация Steam ID: ${steamId}`);
    const steamProfile = await steamAuth.getSteamProfile(steamId);

    let user;
    const result = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    if (result.rows.length === 0) {
      const newUser = await query(
        `INSERT INTO users (steam_id, username, avatar, profile_url, balance, role) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [steamId, steamProfile.personaname, steamProfile.avatar, steamProfile.profileurl, 5000, 'user']
      );
      user = newUser.rows[0];
      console.log(`🎉 Создан новый пользователь: ${steamProfile.personaname}`);
    } else {
      user = result.rows[0];
      await query(
        `UPDATE users SET username = $1, avatar = $2, profile_url = $3, updated_at = NOW() WHERE id = $4`,
        [steamProfile.personaname, steamProfile.avatar, steamProfile.profileurl, user.id]
      );
      user.username = steamProfile.personaname;
      user.avatar = steamProfile.avatar;
      console.log(`🔄 Обновлен пользователь: ${steamProfile.personaname}`);
    }

    const { accessToken, refreshToken } = generateTokens(user);
    const cookieOptions = {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      domain: '.skinssale.kz',
      path: '/'
    };
    res.cookie('accessToken', accessToken, { ...cookieOptions, maxAge: 24 * 60 * 60 * 1000 });
    res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 });

    const userData = {
      id: user.id,
      steamId: user.steam_id,
      username: user.username,
      avatar: user.avatar,
      balance: parseFloat(user.balance),
      role: user.role
    };
    const redirectUrl = `${FRONTEND_URL}/?auth=success&source=callback&accessToken=${accessToken}&refreshToken=${refreshToken}&user=${encodeURIComponent(JSON.stringify(userData))}`;
    console.log(`✅ Успешная аутентификация, редирект: ${redirectUrl}`);
    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error('❌ Steam callback error:', error);
    res.redirect(`${FRONTEND_URL}/auth?status=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.get('/api/auth/user', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        steamId: req.user.steam_id,
        username: req.user.username,
        avatar: req.user.avatar,
        balance: parseFloat(req.user.balance),
        role: req.user.role
      }
    });
  } catch (error) {
    console.error('User data error:', error);
    res.status(500).json({ error: 'Ошибка получения данных пользователя', code: 'USER_DATA_ERROR' });
  }
});

app.post('/api/auth/user-by-token', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ error: 'Токен отсутствует', code: 'TOKEN_MISSING' });
    }
    const decoded = jwt.verify(accessToken, JWT_SECRET);
    const userResult = await query(
      'SELECT id, steam_id, username, avatar, balance, role, is_active FROM users WHERE steam_id = $1 AND is_active = true',
      [decoded.steamId]
    );
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден', code: 'USER_NOT_FOUND' });
    }
    const user = userResult.rows[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        steamId: user.steam_id,
        username: user.username,
        avatar: user.avatar,
        balance: parseFloat(user.balance),
        role: user.role
      }
    });
  } catch (error) {
    console.error('User by token error:', error);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Токен истек', code: 'TOKEN_EXPIRED' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Неверный токен', code: 'INVALID_TOKEN' });
    }
    res.status(500).json({ error: 'Ошибка получения данных пользователя', code: 'USER_DATA_ERROR' });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token отсутствует', code: 'REFRESH_TOKEN_MISSING' });
    }
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const userResult = await query('SELECT id, steam_id, username, avatar, balance, role FROM users WHERE id = $1 AND is_active = true', [decoded.id]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден', code: 'USER_NOT_FOUND' });
    }
    const user = userResult.rows[0];
    const { accessToken } = generateTokens(user);
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      domain: '.skinssale.kz',
      maxAge: 24 * 60 * 60 * 1000
    });
    res.json({
      success: true,
      user: {
        id: user.id,
        steamId: user.steam_id,
        username: user.username,
        avatar: user.avatar,
        balance: parseFloat(user.balance),
        role: user.role
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(403).json({ error: 'Неверный refresh token', code: 'INVALID_REFRESH_TOKEN' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('accessToken', { domain: '.skinssale.kz', path: '/' });
  res.clearCookie('refreshToken', { domain: '.skinssale.kz', path: '/' });
  res.json({ success: true, message: 'Успешный выход' });
});

app.post('/api/auth/dev-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Метод недоступен в production', code: 'METHOD_DISABLED' });
  }
  try {
    const { steamId = '76561197960287930', role = 'user' } = req.body;
    if (!validateSteamId(steamId)) {
      return res.status(400).json({ error: 'Неверный Steam ID', code: 'INVALID_STEAM_ID' });
    }
    const steamProfile = await steamAuth.getSteamProfile(steamId);
    let user;
    const userResult = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    if (userResult.rows.length === 0) {
      const newUserResult = await query(
        `INSERT INTO users (steam_id, username, avatar, profile_url, balance, role) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [steamId, steamProfile.personaname, steamProfile.avatar, steamProfile.profileurl, 5000, role]
      );
      user = newUserResult.rows[0];
    } else {
      user = userResult.rows[0];
      if (role !== user.role) {
        await query('UPDATE users SET role = $1 WHERE id = $2', [role, user.id]);
        user.role = role;
      }
    }
    const { accessToken, refreshToken } = generateTokens(user);
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      domain: '.skinssale.kz',
      maxAge: 24 * 60 * 60 * 1000
    });
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      domain: '.skinssale.kz',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.json({
      success: true,
      user: {
        id: user.id,
        steamId: user.steam_id,
        username: user.username,
        avatar: user.avatar,
        balance: parseFloat(user.balance),
        role: user.role
      },
      message: 'DEV MODE: Успешная аутентификация'
    });
  } catch (error) {
    console.error('DEV Login error:', error);
    res.status(500).json({ error: 'Ошибка авторизации', code: 'AUTH_ERROR' });
  }
});

// ==================== 🚀 ОСНОВНЫЕ РОУТЫ ====================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        steamId: req.user.steam_id,
        username: req.user.username,
        avatar: req.user.avatar,
        balance: parseFloat(req.user.balance),
        role: req.user.role
      }
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Ошибка получения профиля', code: 'PROFILE_ERROR' });
  }
});

app.get('/api/steam/my-inventory', authenticateToken, async (req, res) => {
  try {
    const { appid = '730' } = req.query;
    const inventory = await steamService.getUserInventory(req.user.steam_id, parseInt(appid));
    res.json({ success: true, items: inventory, total: inventory.length });
  } catch (error) {
    console.error('Inventory error:', error);
    res.status(500).json({ error: 'Ошибка получения инвентаря', code: 'INVENTORY_ERROR' });
  }
});

// ==================== 🏪 КАТАЛОГ ТОВАРОВ ====================
app.get('/api/catalog/items', async (req, res) => {
  try {
    const { 
      game = 'cs2', 
      category, 
      subcategory, 
      search,
      minPrice,
      maxPrice,
      rarity,
      quality,
      sort = 'popular',
      limit = 50,
      page = 1,
      featured,
      trending,
      currency = 'KZT'
    } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let queryText = `
      SELECT 
        id, name, price, image_url, rarity, quality, game, 
        market_hash_name, category, subcategory, 
        is_active, is_featured, is_trending,
        steam_price, discount_price, description,
        created_at, updated_at
      FROM items 
      WHERE is_active = true
    `;
    
    let queryParams = [];
    let paramCount = 1;
    
    if (game) {
      queryText += ` AND game = $${paramCount}`;
      queryParams.push(game);
      paramCount++;
    }
    
    if (category) {
      queryText += ` AND category = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }
    
    if (subcategory) {
      queryText += ` AND subcategory = $${paramCount}`;
      queryParams.push(subcategory);
      paramCount++;
    }
    
    if (search) {
      queryText += ` AND (name ILIKE $${paramCount} OR market_hash_name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }
    
    if (minPrice) {
      queryText += ` AND price >= $${paramCount}`;
      queryParams.push(parseFloat(minPrice));
      paramCount++;
    }
    
    if (maxPrice) {
      queryText += ` AND price <= $${paramCount}`;
      queryParams.push(parseFloat(maxPrice));
      paramCount++;
    }
    
    if (rarity) {
      queryText += ` AND rarity = $${paramCount}`;
      queryParams.push(rarity);
      paramCount++;
    }
    
    if (quality) {
      queryText += ` AND quality = $${paramCount}`;
      queryParams.push(quality);
      paramCount++;
    }
    
    if (featured === 'true') {
      queryText += ` AND is_featured = true`;
    }
    
    if (trending === 'true') {
      queryText += ` AND is_trending = true`;
    }
    
    // Сортировка
    switch(sort) {
      case 'price_asc':
        queryText += ' ORDER BY price ASC';
        break;
      case 'price_desc':
        queryText += ' ORDER BY price DESC';
        break;
      case 'newest':
        queryText += ' ORDER BY created_at DESC';
        break;
      case 'popular':
      default:
        queryText += ' ORDER BY is_featured DESC, is_trending DESC, created_at DESC';
        break;
    }
    
    // Получаем общее количество
    const countQuery = queryText.replace('SELECT id, name, price, image_url, rarity, quality, game, market_hash_name, category, subcategory, is_active, is_featured, is_trending, steam_price, discount_price, description, created_at, updated_at', 'SELECT COUNT(*)');
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    
    // Добавляем лимит и оффсет
    queryText += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);
    
    const itemsResult = await query(queryText, queryParams);
    
    // Форматируем цены для указанной валюты
    const items = itemsResult.rows.map(item => {
      const rate = currency === 'USD' ? 1 : 450;
      const price = parseFloat(item.price);
      const finalPrice = currency === 'USD' ? Math.round(price / 450 * 100) / 100 : price;
      
      return {
        ...item,
        price: finalPrice,
        display_price: `${finalPrice.toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
        steam_price: item.steam_price ? parseFloat(item.steam_price) : null,
        discount_price: item.discount_price ? parseFloat(item.discount_price) : null,
        has_discount: item.discount_price && parseFloat(item.discount_price) < parseFloat(item.price)
      };
    });
    
    res.json({
      success: true,
      items: items,
      total: total,
      page: parseInt(page),
      limit: parseInt(limit),
      filters: {
        game,
        category,
        subcategory,
        search,
        minPrice,
        maxPrice,
        rarity,
        quality,
        sort,
        featured,
        trending,
        currency
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки каталога:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка загрузки каталога',
      code: 'CATALOG_ERROR'
    });
  }
});

// Получение одного товара
app.get('/api/catalog/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { currency = 'KZT' } = req.query;
    
    const result = await query(
      `SELECT * FROM items WHERE id = $1 AND is_active = true`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    const item = result.rows[0];
    const rate = currency === 'USD' ? 1 : 450;
    const price = parseFloat(item.price);
    const finalPrice = currency === 'USD' ? Math.round(price / 450 * 100) / 100 : price;
    
    const formattedItem = {
      ...item,
      price: finalPrice,
      display_price: `${finalPrice.toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      steam_price: item.steam_price ? parseFloat(item.steam_price) : null,
      discount_price: item.discount_price ? parseFloat(item.discount_price) : null,
      has_discount: item.discount_price && parseFloat(item.discount_price) < parseFloat(item.price)
    };
    
    res.json({
      success: true,
      item: formattedItem,
      currency: currency,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки товара:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка загрузки товара',
      code: 'ITEM_LOAD_ERROR'
    });
  }
});

// ==================== 🏆 ТОП ПРЕДМЕТЫ ====================
// 🔧 ФУНКЦИЯ ДЛЯ СИНХРОНИЗИРОВАННЫХ ДАННЫХ
function getSyncedTopItems(currency = 'KZT') {
  const rate = currency === 'USD' ? 1 : 450;
  const baseImagesUrl = 'https://cdn2.csgo.com/item/image/width=458/';
  
  const syncedItems = [
    {
      id: 'ak-47-redline-field-tested',
      market_hash_name: 'AK-47 | Redline (Field-Tested)',
      name: 'AK-47 | Redline (Field-Tested)',
      price: Math.round(25.50 * rate),
      display_price: `${Math.round(25.50 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}AK-47%20%7C%20Redline%20(Field-Tested).webp`,
      image_url: `${baseImagesUrl}AK-47%20%7C%20Redline%20(Field-Tested).webp`,
      quality: 'Field-Tested',
      game: 'cs2',
      trending: true,
      category: 'rifles',
      subcategory: 'AK-47',
      rarity: 'Classified',
      popular: true,
      is_featured: true,
      is_trending: true,
      steam_price: Math.round(30.00 * rate)
    },
    {
      id: 'awp-asiimov-field-tested',
      market_hash_name: 'AWP | Asiimov (Field-Tested)',
      name: 'AWP | Asiimov (Field-Tested)',
      price: Math.round(37.25 * rate),
      display_price: `${Math.round(37.25 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}AWP%20%7C%20Asiimov%20(Field-Tested).webp`,
      image_url: `${baseImagesUrl}AWP%20%7C%20Asiimov%20(Field-Tested).webp`,
      quality: 'Field-Tested',
      game: 'cs2',
      popular: true,
      category: 'snipers',
      subcategory: 'AWP',
      rarity: 'Covert',
      trending: false,
      is_featured: true,
      is_trending: false,
      steam_price: Math.round(45.00 * rate)
    },
    {
      id: 'stattrak-awp-ice-coaled-battle-scarred',
      market_hash_name: 'StatTrak™ AWP | Ice Coaled (Battle-Scarred)',
      name: 'StatTrak™ AWP | Ice Coaled (Battle-Scarred)',
      price: Math.round(56.00 * rate),
      display_price: `${Math.round(56.00 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}StatTrak%E2%84%A2%20AWP%20%7C%20Ice%20Coaled%20(Battle-Scarred).webp`,
      image_url: `${baseImagesUrl}StatTrak%E2%84%A2%20AWP%20%7C%20Ice%20Coaled%20(Battle-Scarred).webp`,
      quality: 'Battle-Scarred',
      game: 'cs2',
      popular: true,
      category: 'snipers',
      subcategory: 'AWP',
      rarity: 'Restricted',
      trending: true,
      is_featured: true,
      is_trending: true,
      has_discount: true,
      discount_price: Math.round(50.00 * rate),
      steam_price: Math.round(65.00 * rate)
    },
    {
      id: 'm4a4-howl-factory-new',
      market_hash_name: 'M4A4 | Howl (Factory New)',
      name: 'M4A4 | Howl (Factory New)',
      price: Math.round(170.00 * rate),
      display_price: `${Math.round(170.00 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}M4A4%20%7C%20Howl%20(Factory%20New).webp`,
      image_url: `${baseImagesUrl}M4A4%20%7C%20Howl%20(Factory%20New).webp`,
      quality: 'Factory New',
      game: 'cs2',
      category: 'rifles',
      subcategory: 'M4A4',
      rarity: 'Contraband',
      popular: true,
      trending: true,
      is_featured: true,
      is_trending: true,
      steam_price: Math.round(200.00 * rate)
    },
    {
      id: 'karambit-doppler-factory-new',
      market_hash_name: 'Karambit | Doppler (Factory New)',
      name: 'Karambit | Doppler (Factory New)',
      price: Math.round(250.00 * rate),
      display_price: `${Math.round(250.00 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}phase1/%E2%98%85%20Karambit%20%7C%20Doppler%20(Factory%20New).webp`,
      image_url: `${baseImagesUrl}phase1/%E2%98%85%20Karambit%20%7C%20Doppler%20(Factory%20New).webp`,
      quality: 'Factory New',
      game: 'cs2',
      category: 'knives',
      subcategory: 'Karambit',
      rarity: 'Covert',
      popular: true,
      trending: true,
      is_featured: true,
      is_trending: true,
      steam_price: Math.round(300.00 * rate)
    },
    {
      id: 'desert-eagle-blaze-factory-new',
      market_hash_name: 'Desert Eagle | Blaze (Factory New)',
      name: 'Desert Eagle | Blaze (Factory New)',
      price: Math.round(64.00 * rate),
      display_price: `${Math.round(64.00 * rate).toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
      image: `${baseImagesUrl}Desert%20Eagle%20%7C%20Blaze%20(Factory%20New).webp`,
      image_url: `${baseImagesUrl}Desert%20Eagle%20%7C%20Blaze%20(Factory%20New).webp`,
      quality: 'Factory New',
      game: 'cs2',
      category: 'pistols',
      subcategory: 'Desert Eagle',
      rarity: 'Classified',
      popular: true,
      trending: false,
      is_featured: true,
      is_trending: false,
      steam_price: Math.round(75.00 * rate)
    }
  ];
  
  return syncedItems;
}

// 🔧 ФУНКЦИЯ СИНХРОНИЗАЦИИ С БАЗОЙ ДАННЫХ
async function syncItemsWithDatabase(items) {
  try {
    for (const item of items) {
      try {
        // Проверяем существование предмета
        const existingItem = await query(
          'SELECT id FROM items WHERE market_hash_name = $1',
          [item.market_hash_name]
        );
        
        if (existingItem.rows.length === 0) {
          // Добавляем новый предмет
          await query(`
            INSERT INTO items (
              name, price, image_url, rarity, quality, game, 
              market_hash_name, category, subcategory, 
              is_active, is_featured, is_trending, steam_price, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
          `, [
            item.name,
            item.price,
            item.image_url,
            item.rarity,
            item.quality,
            'cs2',
            item.market_hash_name,
            item.category,
            item.subcategory,
            true,
            item.is_featured,
            item.is_trending,
            item.steam_price
          ]);
          console.log(`✅ Добавлен новый предмет: ${item.name}`);
        } else {
          // Обновляем существующий предмет
          await query(`
            UPDATE items SET
              name = $1,
              price = $2,
              image_url = $3,
              rarity = $4,
              quality = $5,
              is_featured = $6,
              is_trending = $7,
              steam_price = $8,
              updated_at = NOW()
            WHERE market_hash_name = $9
          `, [
            item.name,
            item.price,
            item.image_url,
            item.rarity,
            item.quality,
            item.is_featured,
            item.is_trending,
            item.steam_price,
            item.market_hash_name
          ]);
          console.log(`✅ Обновлен существующий предмет: ${item.name}`);
        }
      } catch (err) {
        console.warn(`⚠️ Ошибка синхронизации предмета "${item.name}":`, err.message);
      }
    }
    console.log('✅ Все предметы синхронизированы с БД');
  } catch (error) {
    console.error('❌ Ошибка синхронизации с БД:', error.message);
  }
}

app.get('/api/catalog/top', async (req, res) => {
  try {
    const { currency = 'KZT', limit = 12 } = req.query;
    const itemsLimit = Math.max(parseInt(limit), 1);
    
    console.log(`🏆 Запрос топовых предметов (${currency}, лимит: ${itemsLimit})`);
    
    // Всегда возвращаем синхронизированные данные
    const topItems = getSyncedTopItems(currency).slice(0, itemsLimit);
    
    res.json({
      success: true,
      items: topItems,
      total: topItems.length,
      category: 'top',
      currency: currency,
      source: 'synced',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки ТОП товаров:', error);
    
    // Fallback на локальные данные
    const fallbackItems = getSyncedTopItems(req.query.currency || 'KZT');
    const finalItems = fallbackItems.slice(0, Math.max(parseInt(req.query.limit) || 12, 1));

    res.json({
      success: true,
      items: finalItems,
      total: finalItems.length,
      category: 'top',
      currency: req.query.currency || 'KZT',
      source: 'fallback',
      timestamp: new Date().toISOString()
    });
  }
});

// Получение категорий
app.get('/api/catalog/categories', async (req, res) => {
  try {
    const { game = 'cs2' } = req.query;
    
    const result = await query(
      `SELECT DISTINCT category FROM items WHERE game = $1 AND is_active = true AND category IS NOT NULL ORDER BY category`,
      [game]
    );
    
    const categories = result.rows.map(row => row.category).filter(Boolean);
    
    res.json({
      success: true,
      categories: categories,
      game: game,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки категорий:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка загрузки категорий',
      code: 'CATEGORIES_ERROR'
    });
  }
});

// Получение подкатегорий
app.get('/api/catalog/subcategories', async (req, res) => {
  try {
    const { game = 'cs2', category } = req.query;
    
    let queryText = `SELECT DISTINCT subcategory FROM items WHERE game = $1 AND is_active = true AND subcategory IS NOT NULL`;
    let queryParams = [game];
    
    if (category) {
      queryText += ` AND category = $2`;
      queryParams.push(category);
    }
    
    queryText += ` ORDER BY subcategory`;
    
    const result = await query(queryText, queryParams);
    
    const subcategories = result.rows.map(row => row.subcategory).filter(Boolean);
    
    res.json({
      success: true,
      subcategories: subcategories,
      game: game,
      category: category,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки подкатегорий:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка загрузки подкатегорий',
      code: 'SUBCATEGORIES_ERROR'
    });
  }
});

// ==================== 👑 АДМИНКА ====================

// 📦 Управление товарами
app.get('/api/admin/items', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log(`📦 Админ: Запрос товаров от пользователя ${req.user.username}`);
    const { game, category, active, search, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let queryText = `
      SELECT * FROM items WHERE 1=1
    `;
    let queryParams = [];
    let paramCount = 1;
    
    if (game) {
      queryText += ` AND game = $${paramCount}`;
      queryParams.push(game);
      paramCount++;
    }
    
    if (category) {
      queryText += ` AND category = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }
    
    if (active !== undefined) {
      queryText += ` AND is_active = $${paramCount}`;
      queryParams.push(active === 'true');
      paramCount++;
    }
    
    if (search) {
      queryText += ` AND (name ILIKE $${paramCount} OR market_hash_name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }
    
    queryText += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);
    
    const itemsResult = await query(queryText, queryParams);
    const countResult = await query(
      `SELECT COUNT(*) FROM items WHERE 1=1` + 
      (game ? ` AND game = '${game}'` : '') +
      (category ? ` AND category = '${category}'` : '') +
      (active !== undefined ? ` AND is_active = ${active === 'true'}` : ''),
      []
    );
    
    res.json({
      success: true,
      items: itemsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Admin items error:', error);
    res.status(500).json({ error: 'Ошибка получения товаров', code: 'ADMIN_ITEMS_ERROR' });
  }
});

// Создание товара
app.post('/api/admin/items', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      price,
      image_url,
      rarity,
      quality,
      game,
      market_hash_name,
      category,
      subcategory,
      is_active = true,
      is_featured = false,
      is_trending = false,
      description,
      steam_price,
      discount_price
    } = req.body;
    
    if (!name || !price || !image_url || !game) {
      return res.status(400).json({
        error: 'Заполните обязательные поля: название, цена, изображение, игра',
        code: 'VALIDATION_ERROR'
      });
    }
    
    const result = await query(
      `INSERT INTO items (
        name, price, image_url, rarity, quality, game, market_hash_name,
        category, subcategory, is_active, is_featured, is_trending,
        description, steam_price, discount_price, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
      RETURNING *`,
      [
        name,
        parseFloat(price),
        image_url,
        rarity || 'Consumer',
        quality || 'Field-Tested',
        game,
        market_hash_name || '',
        category || '',
        subcategory || '',
        Boolean(is_active),
        Boolean(is_featured),
        Boolean(is_trending),
        description || '',
        steam_price ? parseFloat(steam_price) : null,
        discount_price ? parseFloat(discount_price) : null
      ]
    );
    
    res.json({
      success: true,
      item: result.rows[0],
      message: 'Товар успешно создан'
    });
  } catch (error) {
    console.error('Create item error:', error);
    if (error.code === '23505') {
      return res.status(400).json({
        error: 'Товар с таким market_hash_name уже существует',
        code: 'DUPLICATE_ITEM'
      });
    }
    res.status(500).json({ error: 'Ошибка создания товара', code: 'CREATE_ITEM_ERROR' });
  }
});

// Обновление товара
app.put('/api/admin/items/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const currentResult = await query('SELECT * FROM items WHERE id = $1', [id]);
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    const currentItem = currentResult.rows[0];
    
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;
    
    const allowedFields = [
      'name', 'price', 'image_url', 'rarity', 'quality', 'game',
      'market_hash_name', 'category', 'subcategory', 'is_active',
      'is_featured', 'is_trending', 'description', 'steam_price',
      'discount_price'
    ];
    
    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = $${paramCount}`);
        
        if (field === 'price' || field === 'steam_price' || field === 'discount_price') {
          updateValues.push(updates[field] ? parseFloat(updates[field]) : null);
        } else if (field === 'is_active' || field === 'is_featured' || field === 'is_trending') {
          updateValues.push(Boolean(updates[field]));
        } else {
          updateValues.push(updates[field]);
        }
        
        paramCount++;
      }
    });
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        error: 'Нет данных для обновления',
        code: 'NO_UPDATES'
      });
    }
    
    updateFields.push(`updated_at = $${paramCount}`);
    updateValues.push(new Date());
    paramCount++;
    
    updateValues.push(id);
    
    const queryText = `
      UPDATE items 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const result = await query(queryText, updateValues);
    
    res.json({
      success: true,
      item: result.rows[0],
      message: 'Товар успешно обновлен'
    });
  } catch (error) {
    console.error('Update item error:', error);
    res.status(500).json({ error: 'Ошибка обновления товара', code: 'UPDATE_ITEM_ERROR' });
  }
});

// Удаление товара
app.delete('/api/admin/items/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const checkResult = await query('SELECT * FROM items WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    try {
      await query('DELETE FROM top_items WHERE item_id = $1', [id]);
    } catch (error) {
      console.log('Товар не был в ТОПе или таблицы нет');
    }
    
    await query('DELETE FROM items WHERE id = $1', [id]);
    
    res.json({
      success: true,
      message: 'Товар успешно удален'
    });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: 'Ошибка удаления товара', code: 'DELETE_ITEM_ERROR' });
  }
});

// Изменение статуса активности
app.put('/api/admin/items/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
    const result = await query(
      'UPDATE items SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [Boolean(is_active), id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      item: result.rows[0],
      message: `Товар ${is_active ? 'активирован' : 'деактивирован'}`
    });
  } catch (error) {
    console.error('Toggle item error:', error);
    res.status(500).json({ error: 'Ошибка изменения статуса товара', code: 'TOGGLE_ITEM_ERROR' });
  }
});

// Изменение статуса рекомендуемого
app.put('/api/admin/items/:id/featured', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_featured } = req.body;
    
    const result = await query(
      'UPDATE items SET is_featured = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [Boolean(is_featured), id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      item: result.rows[0],
      message: `Товар ${is_featured ? 'добавлен в рекомендуемые' : 'удален из рекомендуемых'}`
    });
  } catch (error) {
    console.error('Toggle featured error:', error);
    res.status(500).json({ error: 'Ошибка изменения статуса рекомендуемого', code: 'TOGGLE_FEATURED_ERROR' });
  }
});

// Изменение статуса трендового
app.put('/api/admin/items/:id/trending', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_trending } = req.body;
    
    const result = await query(
      'UPDATE items SET is_trending = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [Boolean(is_trending), id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Товар не найден',
        code: 'ITEM_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      item: result.rows[0],
      message: `Товар ${is_trending ? 'добавлен в трендовые' : 'удален из трендовых'}`
    });
  } catch (error) {
    console.error('Toggle trending error:', error);
    res.status(500).json({ error: 'Ошибка изменения статуса трендового', code: 'TOGGLE_TRENDING_ERROR' });
  }
});

// 🏆 Управление ТОП товарами
app.get('/api/admin/top', authenticateToken, requireAdmin, async (req, res) => {
  try {
    try {
      const result = await query(`
        SELECT ti.item_id, ti.position 
        FROM top_items ti
        JOIN items i ON ti.item_id = i.id
        WHERE i.is_active = true
        ORDER BY ti.position ASC
      `);
      
      const top_item_ids = result.rows.map(row => row.item_id);
      
      return res.json({
        success: true,
        top_item_ids: top_item_ids,
        total: top_item_ids.length
      });
    } catch (error) {
      console.log('Таблица top_items не найдена, создаем...');
    }
    
    res.json({
      success: true,
      top_item_ids: [],
      total: 0
    });
  } catch (error) {
    console.error('Get top items error:', error);
    res.status(500).json({ error: 'Ошибка получения ТОП товаров', code: 'GET_TOP_ERROR' });
  }
});

// Сохранение ТОП товаров
app.post('/api/admin/top', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { top_item_ids } = req.body;
    
    if (!Array.isArray(top_item_ids)) {
      return res.status(400).json({
        error: 'Неверный формат данных',
        code: 'INVALID_DATA'
      });
    }
    
    const limitedIds = top_item_ids.slice(0, 10);
    
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS top_items (
          id SERIAL PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(item_id)
        )
      `);
    } catch (error) {
      console.log('Таблица top_items уже существует');
    }
    
    await query('DELETE FROM top_items');
    
    for (let i = 0; i < limitedIds.length; i++) {
      const itemId = limitedIds[i];
      
      const itemCheck = await query('SELECT id FROM items WHERE id = $1 AND is_active = true', [itemId]);
      if (itemCheck.rows.length > 0) {
        await query(
          'INSERT INTO top_items (item_id, position) VALUES ($1, $2)',
          [itemId, i + 1]
        );
      }
    }
    
    res.json({
      success: true,
      top_item_ids: limitedIds,
      message: 'ТОП товары успешно сохранены'
    });
  } catch (error) {
    console.error('Save top items error:', error);
    res.status(500).json({ error: 'Ошибка сохранения ТОП товаров', code: 'SAVE_TOP_ERROR' });
  }
});

// 👥 Управление пользователями
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log(`👥 Админ: Запрос пользователей от ${req.user.username}`);
    const { page = 1, limit = 20, search, role } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    let queryText = `
      SELECT id, steam_id, username, avatar, balance, role, is_active, 
             created_at, updated_at, last_login
      FROM users WHERE 1=1
    `;
    let queryParams = [];
    let paramCount = 1;
    
    if (search) {
      queryText += ` AND (username ILIKE $${paramCount} OR steam_id::text LIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }
    
    if (role) {
      queryText += ` AND role = $${paramCount}`;
      queryParams.push(role);
      paramCount++;
    }
    
    queryText += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(limit, offset);
    
    const usersResult = await query(queryText, queryParams);
    const countResult = await query(
      'SELECT COUNT(*) as total FROM users' + 
      (search ? ` WHERE (username ILIKE '%${search}%' OR steam_id::text LIKE '%${search}%')` : ''),
      []
    );
    
    res.json({ 
      success: true, 
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Ошибка получения пользователей', code: 'ADMIN_USERS_ERROR' });
  }
});

// Пополнение баланса пользователя
app.post('/api/admin/update-balance', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { steamId, amount, reason } = req.body;
    
    if (!steamId || !amount || amount <= 0) {
      return res.status(400).json({
        error: 'Неверные данные',
        code: 'INVALID_DATA'
      });
    }
    
    await query('BEGIN');
    
    const userResult = await query('SELECT id, balance FROM users WHERE steam_id = $1', [steamId]);
    if (userResult.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    const userId = userResult.rows[0].id;
    const currentBalance = parseFloat(userResult.rows[0].balance);
    
    await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
    
    await query(
      `INSERT INTO payments (user_id, order_id, amount, currency, status, type, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        `admin_topup_${Date.now()}`,
        amount,
        'USD',
        'completed',
        'deposit',
        reason || 'Административное пополнение'
      ]
    );
    
    const newBalanceResult = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    const newBalance = parseFloat(newBalanceResult.rows[0].balance);
    
    await query('COMMIT');
    
    res.json({
      success: true,
      amount: amount,
      oldBalance: currentBalance,
      newBalance: newBalance,
      message: 'Баланс успешно пополнен'
    });
  } catch (error) {
    await query('ROLLBACK');
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Ошибка пополнения баланса', code: 'UPDATE_BALANCE_ERROR' });
  }
});

// Блокировка/разблокировка пользователя
app.post('/api/admin/toggle-user', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { steamId, isActive } = req.body;
    
    const result = await query(
      'UPDATE users SET is_active = $1, updated_at = NOW() WHERE steam_id = $2 RETURNING *',
      [Boolean(isActive), steamId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      user: result.rows[0],
      message: `Пользователь ${isActive ? 'разблокирован' : 'заблокирован'}`
    });
  } catch (error) {
    console.error('Toggle user error:', error);
    res.status(500).json({ error: 'Ошибка изменения статуса пользователя', code: 'TOGGLE_USER_ERROR' });
  }
});

// 🛡️ Управление администраторами
app.get('/api/admin/admins', authenticateToken, requireOwner, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, steam_id, username, avatar, role, created_at 
       FROM users 
       WHERE role IN ('admin', 'owner')
       ORDER BY role DESC, created_at ASC`
    );
    
    res.json({
      success: true,
      admins: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({ error: 'Ошибка получения списка администраторов', code: 'GET_ADMINS_ERROR' });
  }
});

// Добавление администратора
app.post('/api/admin/admins', authenticateToken, requireOwner, async (req, res) => {
  try {
    const { steamId } = req.body;
    
    if (!steamId || !validateSteamId(steamId)) {
      return res.status(400).json({
        error: 'Неверный Steam ID',
        code: 'INVALID_STEAM_ID'
      });
    }
    
    const userResult = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    const result = await query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE steam_id = $2 RETURNING *',
      ['admin', steamId]
    );
    
    res.json({
      success: true,
      admin: result.rows[0],
      message: 'Администратор успешно добавлен'
    });
  } catch (error) {
    console.error('Add admin error:', error);
    res.status(500).json({ error: 'Ошибка добавления администратора', code: 'ADD_ADMIN_ERROR' });
  }
});

// Удаление администратора
app.delete('/api/admin/admins/:steamId', authenticateToken, requireOwner, async (req, res) => {
  try {
    const { steamId } = req.params;
    
    const userResult = await query('SELECT role FROM users WHERE steam_id = $1', [steamId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    if (userResult.rows[0].role === 'owner') {
      return res.status(403).json({
        error: 'Нельзя удалить владельца',
        code: 'CANNOT_REMOVE_OWNER'
      });
    }
    
    const result = await query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE steam_id = $2 RETURNING *',
      ['user', steamId]
    );
    
    res.json({
      success: true,
      message: 'Администратор успешно удален'
    });
  } catch (error) {
    console.error('Remove admin error:', error);
    res.status(500).json({ error: 'Ошибка удаления администратора', code: 'REMOVE_ADMIN_ERROR' });
  }
});

// 📊 Транзакции
app.get('/api/admin/transactions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { filter = 'all', limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let queryText = `
      SELECT p.*, u.username, u.steam_id
      FROM payments p
      JOIN users u ON p.user_id = u.id
      WHERE 1=1
    `;
    let queryParams = [];
    
    if (filter === 'deposit') {
      queryText += ` AND p.type = 'deposit'`;
    } else if (filter === 'withdraw') {
      queryText += ` AND p.type = 'withdraw'`;
    } else if (filter === 'pending') {
      queryText += ` AND p.status = 'pending'`;
    }
    
    queryText += ` ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`;
    queryParams.push(limit, offset);
    
    const transactionsResult = await query(queryText, queryParams);
    const countResult = await query(
      `SELECT COUNT(*) FROM payments WHERE 1=1` +
      (filter === 'deposit' ? ` AND type = 'deposit'` : '') +
      (filter === 'withdraw' ? ` AND type = 'withdraw'` : '') +
      (filter === 'pending' ? ` AND status = 'pending'` : ''),
      []
    );
    
    res.json({
      success: true,
      transactions: transactionsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Admin transactions error:', error);
    res.status(500).json({ error: 'Ошибка получения транзакций', code: 'ADMIN_TRANSACTIONS_ERROR' });
  }
});

// 📋 Статистика
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersStats = await query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_users_7d,
        COUNT(*) FILTER (WHERE is_active = true) as active_users,
        COUNT(*) FILTER (WHERE balance > 0) as users_with_balance
      FROM users
    `);
    
    const itemsStats = await query(`
      SELECT 
        COUNT(*) as total_items,
        COUNT(*) FILTER (WHERE is_active = true) as active_items,
        COUNT(*) FILTER (WHERE is_featured = true) as featured_items,
        COUNT(*) FILTER (WHERE is_trending = true) as trending_items
      FROM items
    `);
    
    const paymentsStats = await query(`
      SELECT 
        COUNT(*) as total_payments,
        COALESCE(SUM(amount), 0) as total_volume,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as payments_24h,
        COUNT(*) FILTER (WHERE type = 'deposit') as deposits,
        COUNT(*) FILTER (WHERE type = 'withdraw') as withdrawals
      FROM payments 
      WHERE status = 'completed'
    `);
    
    const revenueStats = await query(`
      SELECT 
        DATE(created_at) as date,
        SUM(amount) as daily_revenue
      FROM payments 
      WHERE type = 'deposit' 
        AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `);
    
    res.json({
      success: true,
      users: usersStats.rows[0],
      items: itemsStats.rows[0],
      payments: paymentsStats.rows[0],
      revenue: revenueStats.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ 
      error: 'Ошибка получения статистики', 
      code: 'STATS_ERROR' 
    });
  }
});

// 📨 Управление тикетами
app.get('/api/admin/tickets', authenticateToken, requireAdmin, async (req, res) => {
  try {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          username VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          subject VARCHAR(255) NOT NULL,
          category VARCHAR(100),
          status VARCHAR(50) DEFAULT 'open',
          messages JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } catch (error) {
      console.log('Таблица support_tickets уже существует');
    }
    
    const result = await query(`
      SELECT * FROM support_tickets 
      ORDER BY updated_at DESC
    `);
    
    res.json({
      success: true,
      tickets: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ error: 'Ошибка получения тикетов', code: 'GET_TICKETS_ERROR' });
  }
});

// Ответ на тикет
app.post('/api/admin/tickets/:id/reply', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({
        error: 'Введите сообщение',
        code: 'EMPTY_MESSAGE'
      });
    }
    
    const ticketResult = await query('SELECT * FROM support_tickets WHERE id = $1', [id]);
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Тикет не найден',
        code: 'TICKET_NOT_FOUND'
      });
    }
    
    const ticket = ticketResult.rows[0];
    const messages = ticket.messages || [];
    
    const newMessage = {
      id: Date.now(),
      text: message.trim(),
      sender: 'admin',
      senderName: req.user.username,
      timestamp: new Date().toISOString()
    };
    
    messages.push(newMessage);
    
    const updatedResult = await query(
      `UPDATE support_tickets 
       SET messages = $1, status = 'answered', updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(messages), id]
    );
    
    res.json({
      success: true,
      ticket: updatedResult.rows[0],
      message: 'Ответ отправлен'
    });
  } catch (error) {
    console.error('Reply ticket error:', error);
    res.status(500).json({ error: 'Ошибка отправки ответа', code: 'REPLY_TICKET_ERROR' });
  }
});

// Изменение статуса тикета
app.put('/api/admin/tickets/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const allowedStatuses = ['open', 'answered', 'resolved', 'closed'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Неверный статус',
        code: 'INVALID_STATUS'
      });
    }
    
    const result = await query(
      'UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Тикет не найден',
        code: 'TICKET_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      ticket: result.rows[0],
      message: 'Статус тикета обновлен'
    });
  } catch (error) {
    console.error('Update ticket status error:', error);
    res.status(500).json({ error: 'Ошибка обновления статуса тикета', code: 'UPDATE_TICKET_STATUS_ERROR' });
  }
});

// ==================== 🏪 МАРКЕТ ====================
app.get('/api/items/market', async (req, res) => {
  try {
    const { game = 'cs2', limit = 50, currency = 'KZT' } = req.query;
    console.log(`📦 Запрос предметов с парсера: ${game}, лимит: ${limit}`);
    
    try {
      const dbResult = await query(
        `SELECT * FROM items WHERE game = $1 AND is_active = true ORDER BY created_at DESC LIMIT $2`,
        [game, parseInt(limit)]
      );
      
      if (dbResult.rows.length > 0) {
        const items = dbResult.rows.map(item => {
          const rate = currency === 'USD' ? 1 : 450;
          const price = parseFloat(item.price);
          const finalPrice = currency === 'USD' ? Math.round(price / 450 * 100) / 100 : price;
          
          return {
            ...item,
            price: finalPrice,
            display_price: `${finalPrice.toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
            steam_price: item.steam_price ? parseFloat(item.steam_price) : null,
            discount_price: item.discount_price ? parseFloat(item.discount_price) : null,
            has_discount: item.discount_price && parseFloat(item.discount_price) < parseFloat(item.price)
          };
        });
        
        return res.json({
          success: true,
          items: items,
          total: items.length,
          game: game,
          currency: currency,
          source: 'database',
          timestamp: new Date().toISOString()
        });
      }
    } catch (dbError) {
      console.log('Не удалось загрузить из БД, используем fallback');
    }
    
    const fallbackItems = getSyncedTopItems(currency).slice(0, parseInt(limit));
    
    res.json({
      success: true,
      items: fallbackItems,
      total: fallbackItems.length,
      game: game,
      currency: currency,
      source: 'synced_fallback',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки предметов:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка загрузки предметов',
      code: 'MARKET_LOAD_ERROR'
    });
  }
});

// Поиск
app.get('/api/items/search', async (req, res) => {
  try {
    const { q: query, game = 'cs2', currency = 'KZT', limit = 50 } = req.query;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Поисковый запрос должен содержать минимум 2 символа',
        code: 'INVALID_SEARCH_QUERY'
      });
    }
    
    const result = await query(
      `SELECT * FROM items 
       WHERE is_active = true 
         AND (name ILIKE $1 OR market_hash_name ILIKE $1 OR category ILIKE $1)
       LIMIT $2`,
      [`%${query}%`, parseInt(limit)]
    );
    
    const items = result.rows.map(item => {
      const rate = currency === 'USD' ? 1 : 450;
      const price = parseFloat(item.price);
      const finalPrice = currency === 'USD' ? Math.round(price / 450 * 100) / 100 : price;
      
      return {
        ...item,
        price: finalPrice,
        display_price: `${finalPrice.toLocaleString('ru-RU')} ${currency === 'USD' ? '$' : '₸'}`,
        steam_price: item.steam_price ? parseFloat(item.steam_price) : null,
        discount_price: item.discount_price ? parseFloat(item.discount_price) : null,
        has_discount: item.discount_price && parseFloat(item.discount_price) < parseFloat(item.price)
      };
    });
    
    res.json({
      success: true,
      items: items,
      total: items.length,
      query: query,
      game: game,
      currency: currency,
      source: 'database',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка поиска:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка поиска предметов',
      code: 'SEARCH_ERROR'
    });
  }
});

// ==================== 🩺 HEALTH & START ====================
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    
    const tablesCheck = await query(`
      SELECT 
        (SELECT COUNT(*) FROM items) as items_count,
        (SELECT COUNT(*) FROM users) as users_count,
        (SELECT COUNT(*) FROM payments) as payments_count
    `);
    
    res.json({ 
      status: 'healthy', 
      database: 'OK',
      tables: tablesCheck.rows[0],
      timestamp: new Date().toISOString(),
      server: 'SkinSale API',
      version: '3.0.1',
      features: {
        admin_panel: 'enabled',
        catalog: 'enabled',
        payments: 'enabled',
        steam_auth: 'enabled',
        synced_items: 'enabled'
      }
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Обработка несуществующих API роутов
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API route not found', 
    code: 'API_ROUTE_NOT_FOUND',
    path: req.originalUrl 
  });
});

// Глобальный обработчик ошибок
app.use((error, req, res, next) => {
  console.error('🚨 Глобальная ошибка:', error);
  res.status(500).json({ 
    error: 'Внутренняя ошибка сервера', 
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
  });
});

// ==================== 🔧 ФУНКЦИЯ ОБНОВЛЕНИЯ БАЗЫ ДАННЫХ ====================
const updateDatabase = async () => {
  try {
    console.log('🔄 Проверка структуры базы данных...');
    
    // 1. Добавляем колонку email в users
    try {
      await query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS email VARCHAR(255)
      `);
      console.log('✅ Колонка email добавлена или уже существует');
    } catch (e) {
      console.log('ℹ️ Колонка email уже существует:', e.message);
    }
    
    // 2. Добавляем недостающие колонки в items
    const columnsToAdd = [
      { name: 'steam_price', type: 'NUMERIC(10,2)' },
      { name: 'discount_price', type: 'NUMERIC(10,2)' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'BOOLEAN DEFAULT true' },
      { name: 'is_featured', type: 'BOOLEAN DEFAULT false' },
      { name: 'is_trending', type: 'BOOLEAN DEFAULT false' },
      { name: 'subcategory', type: 'TEXT' }
    ];
    
    for (const column of columnsToAdd) {
      try {
        await query(`
          ALTER TABLE items ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}
        `);
        console.log(`✅ Колонка ${column.name} добавлена или уже существует`);
      } catch (e) {
        console.log(`ℹ️ Колонка ${column.name} уже существует или ошибка:`, e.message);
      }
    }
    
    // 3. Добавляем UNIQUE constraint для market_hash_name
    try {
      const checkConstraint = await query(`
        SELECT constraint_name 
        FROM information_schema.table_constraints 
        WHERE table_name = 'items' 
          AND constraint_type = 'UNIQUE' 
          AND constraint_name LIKE '%market_hash_name%'
      `);
      
      if (checkConstraint.rows.length === 0) {
        await query(`
          ALTER TABLE items 
          ADD CONSTRAINT unique_market_hash_name UNIQUE (market_hash_name)
        `);
        console.log('✅ Unique constraint добавлен для market_hash_name');
      } else {
        console.log('✅ Unique constraint уже существует для market_hash_name');
      }
    } catch (e) {
      console.log('ℹ️ Unique constraint для market_hash_name:', e.message);
    }
    
    // 4. Создаем таблицу top_items
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS top_items (
          id SERIAL PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(item_id)
        )
      `);
      console.log('✅ Таблица top_items создана или уже существует');
    } catch (e) {
      console.log('ℹ️ Таблица top_items уже существует или ошибка:', e.message);
    }
    
    // 5. Создаем таблицу promotions
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS promotions (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          discount DECIMAL(5,2) NOT NULL,
          item_ids JSONB NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Таблица promotions создана или уже существует');
    } catch (e) {
      console.log('ℹ️ Таблица promotions уже существует или ошибка:', e.message);
    }
    
    // 6. Создаем таблицу support_tickets
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          username VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          subject VARCHAR(255) NOT NULL,
          category VARCHAR(100),
          status VARCHAR(50) DEFAULT 'open',
          messages JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Таблица support_tickets создана или уже существует');
    } catch (e) {
      console.log('ℹ️ Таблица support_tickets уже существует или ошибка:', e.message);
    }
    
  } catch (error) {
    console.log('ℹ️ База данных уже обновлена или ошибка:', error.message);
  }
};

// 🔧 ФУНКЦИЯ СИНХРОНИЗАЦИИ НАЧАЛЬНЫХ ДАННЫХ
async function syncInitialItems() {
// Функция синхронизации начальных данных
async function syncInitialItems() {
  try {
    console.log('🔄 Синхронизация начальных данных с фронтендом...');
    
    const syncedItems = getSyncedTopItems('KZT');
    let syncedCount = 0;
    
    for (const item of syncedItems) {
      try {
        // 🔧 ИСПРАВЛЕНИЕ: Проверяем существование предмета без ON CONFLICT сначала
        const existingItem = await query(
          'SELECT id FROM items WHERE market_hash_name = $1',
          [item.market_hash_name]
        );
        
        if (existingItem.rows.length === 0) {
          // Добавляем новый предмет
          await query(`
            INSERT INTO items (
              name, price, image_url, rarity, quality, game, 
              market_hash_name, category, subcategory, 
              is_active, is_featured, is_trending, steam_price, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
          `, [
            item.name,
            item.price,
            item.image_url,
            item.rarity,
            item.quality,
            'cs2',
            item.market_hash_name,
            item.category,
            item.subcategory,
            true,
            item.is_featured,
            item.is_trending,
            item.steam_price
          ]);
          console.log(`✅ Добавлен новый предмет: ${item.name}`);
          syncedCount++;
        } else {
          // Обновляем существующий предмет
          await query(`
            UPDATE items SET
              name = $1,
              price = $2,
              image_url = $3,
              rarity = $4,
              quality = $5,
              is_featured = $6,
              is_trending = $7,
              steam_price = $8,
              updated_at = NOW()
            WHERE market_hash_name = $9
          `, [
            item.name,
            item.price,
            item.image_url,
            item.rarity,
            item.quality,
            item.is_featured,
            item.is_trending,
            item.steam_price,
            item.market_hash_name
          ]);
          console.log(`✅ Обновлен существующий предмет: ${item.name}`);
          syncedCount++;
        }
      } catch (err) {
        console.warn(`⚠️ Ошибка синхронизации предмета "${item.name}":`, err.message);
        
        // 🔧 АЛЬТЕРНАТИВНЫЙ СПОСОБ: Пробуем без market_hash_name constraint
        try {
          // Проверяем по name если market_hash_name не работает
          const existingByName = await query(
            'SELECT id FROM items WHERE name = $1',
            [item.name]
          );
          
          if (existingByName.rows.length === 0) {
            await query(`
              INSERT INTO items (
                name, price, image_url, rarity, quality, game, 
                category, subcategory, 
                is_active, is_featured, is_trending, steam_price, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            `, [
              item.name,
              item.price,
              item.image_url,
              item.rarity,
              item.quality,
              'cs2',
              item.category,
              item.subcategory,
              true,
              item.is_featured,
              item.is_trending,
              item.steam_price
            ]);
            console.log(`✅ Добавлен (альтернативный способ): ${item.name}`);
            syncedCount++;
          }
        } catch (innerErr) {
          console.error(`❌ Критическая ошибка добавления "${item.name}":`, innerErr.message);
        }
      }
    }
    
    console.log(`✅ Синхронизировано ${syncedCount} из ${syncedItems.length} предметов`);
    
    // Проверяем количество товаров в БД
    const check = await query('SELECT COUNT(*) as count FROM items');
    const count = parseInt(check.rows[0].count);
    console.log(`📊 Всего предметов в БД: ${count}`);
    
  } catch (error) {
    console.error('❌ Ошибка синхронизации начальных данных:', error);
  }
}

startServer();
