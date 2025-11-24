// middleware/firewall.js
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
const geoip = require('geoip-lite');

// Списки для блокировок
const SUSPICIOUS_USER_AGENTS = [
  'sqlmap', 'nikto', 'metasploit', 'nessus', 'acunetix',
  'appscan', 'burpsuite', 'w3af', 'zap', 'nmap', 'gobuster',
  'dirbuster', 'hydra', 'medusa', 'patator', 'whatweb',
  'subfinder', 'sublist3r', 'amass', 'masscan', 'ffuf'
];

const BLOCKED_COUNTRIES = [
  'KP', // Северная Корея
  'IR', // Иран
  'SY', // Сирия
  'CU', // Куба
  'RU'  // Россия (если нужно)
];

const BLOCKED_IPS = new Set();
const SUSPICIOUS_IPS = new Map();
const REQUEST_LOGS = new Map();

class Firewall {
  constructor() {
    this.rateLimiters = this.createRateLimiters();
    this.setupSecurityHeaders();
  }

  // Создание лимитеров запросов
  createRateLimiters() {
    return {
      general: rateLimit({
        windowMs: 15 * 60 * 1000, // 15 минут
        max: 1000, // максимум 1000 запросов
        message: { error: 'Слишком много запросов' },
        standardHeaders: true,
        legacyHeaders: false,
      }),
      auth: rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10, // 10 попыток входа
        message: { error: 'Слишком много попыток входа' },
      }),
      api: rateLimit({
        windowMs: 1 * 60 * 1000, // 1 минута
        max: 60, // 60 запросов в минуту
        message: { error: 'API лимит превышен' },
      }),
      payment: rateLimit({
        windowMs: 5 * 60 * 1000, // 5 минут
        max: 20, // 20 платежных операций
        message: { error: 'Слишком много платежных операций' },
      })
    };
  }

  // Настройка security headers
  setupSecurityHeaders() {
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:", "blob:"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", "https://sandboxapi.paymtech.kz", "https://api.paymtech.kz"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      },
      noSniff: true,
      xssFilter: true,
      frameguard: { action: 'deny' }
    });
  }

  // CORS настройка
  setupCORS() {
    return cors({
      origin: (origin, callback) => {
        const allowedOrigins = [
          'https://skinsale.kz',
          'https://www.skinsale.kz',
          'http://localhost:3000',
          'http://localhost:5173'
        ];
        
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS не разрешен'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
    });
  }

  // Проверка IP
  checkIP(ip) {
    // Проверка в черном списке
    if (BLOCKED_IPS.has(ip)) {
      return { allowed: false, reason: 'IP заблокирован' };
    }

    // Проверка геолокации
    const geo = geoip.lookup(ip);
    if (geo && BLOCKED_COUNTRIES.includes(geo.country)) {
      BLOCKED_IPS.add(ip);
      return { allowed: false, reason: 'Регион заблокирован' };
    }

    // Проверка подозрительной активности
    const suspiciousData = SUSPICIOUS_IPS.get(ip);
    if (suspiciousData && suspiciousData.count > 10) {
      BLOCKED_IPS.add(ip);
      return { allowed: false, reason: 'Подозрительная активность' };
    }

    return { allowed: true };
  }

  // Проверка User-Agent
  checkUserAgent(userAgent) {
    if (!userAgent) return { allowed: false, reason: 'User-Agent отсутствует' };

    const ua = userAgent.toLowerCase();
    const isSuspicious = SUSPICIOUS_USER_AGENTS.some(agent => 
      ua.includes(agent.toLowerCase())
    );

    if (isSuspicious) {
      return { allowed: false, reason: 'Подозрительный User-Agent' };
    }

    return { allowed: true };
  }

  // Валидация входящих данных
  validateInput(data, rules) {
    const errors = [];
    
    // Проверка на SQL-инъекции
    const sqlInjectionPatterns = [
      /(\bUNION\b.*\bSELECT\b)/i,
      /(\bDROP\b.*\bTABLE\b)/i,
      /(\bINSERT\b.*\bINTO\b)/i,
      /(\bDELETE\b.*\bFROM\b)/i,
      /(\bUPDATE\b.*\bSET\b)/i,
      /('|\"|;|--|\/\*|\*\/)/,
      /(\bOR\b.*=.*\bOR\b)/i
    ];

    const checkForInjection = (value) => {
      if (typeof value === 'string') {
        return sqlInjectionPatterns.some(pattern => pattern.test(value));
      }
      return false;
    };

    // Рекурсивная проверка объекта
    const checkObject = (obj) => {
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            checkObject(obj[key]);
          } else if (checkForInjection(obj[key])) {
            errors.push(`Потенциальная SQL-инъекция в поле ${key}`);
          }
        }
      }
    };

    checkObject(data);
    return errors;
  }

  // Логирование запросов
  logRequest(ip, path, userAgent) {
    const now = Date.now();
    const key = `${ip}-${path}`;
    
    if (!REQUEST_LOGS.has(key)) {
      REQUEST_LOGS.set(key, []);
    }
    
    const logs = REQUEST_LOGS.get(key);
    logs.push(now);
    
    // Очистка старых логов (старше 1 часа)
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentLogs = logs.filter(time => time > oneHourAgo);
    REQUEST_LOGS.set(key, recentLogs);
    
    // Проверка на подозрительную активность
    if (recentLogs.length > 100) { // больше 100 запросов в час
      this.markSuspiciousIP(ip, 'Высокая частота запросов');
    }
  }

  // Отметка подозрительного IP
  markSuspiciousIP(ip, reason) {
    if (!SUSPICIOUS_IPS.has(ip)) {
      SUSPICIOUS_IPS.set(ip, { count: 1, reasons: [reason], firstSeen: Date.now() });
    } else {
      const data = SUSPICIOUS_IPS.get(ip);
      data.count++;
      data.reasons.push(reason);
      SUSPICIOUS_IPS.set(ip, data);
    }
  }

  // Middleware для проверки запросов
  checkRequest() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const userAgent = req.get('User-Agent');
      const path = req.path;

      // Логирование запроса
      this.logRequest(ip, path, userAgent);

      // Проверка IP
      const ipCheck = this.checkIP(ip);
      if (!ipCheck.allowed) {
        return res.status(403).json({ 
          error: 'Доступ запрещен', 
          reason: ipCheck.reason 
        });
      }

      // Проверка User-Agent
      const uaCheck = this.checkUserAgent(userAgent);
      if (!uaCheck.allowed) {
        this.markSuspiciousIP(ip, uaCheck.reason);
        return res.status(403).json({ 
          error: 'Доступ запрещен', 
          reason: uaCheck.reason 
        });
      }

      // Проверка данных запроса
      if (req.body && Object.keys(req.body).length > 0) {
        const validationErrors = this.validateInput(req.body);
        if (validationErrors.length > 0) {
          this.markSuspiciousIP(ip, 'Попытка инъекции');
          return res.status(400).json({ 
            error: 'Неверные данные', 
            details: validationErrors 
          });
        }
      }

      next();
    };
  }

  // Получение статистики безопасности
  getSecurityStats() {
    return {
      blockedIPs: BLOCKED_IPS.size,
      suspiciousIPs: SUSPICIOUS_IPS.size,
      totalRequests: Array.from(REQUEST_LOGS.values()).reduce((sum, logs) => sum + logs.length, 0)
    };
  }

  // Разблокировка IP (для админки)
  unblockIP(ip) {
    BLOCKED_IPS.delete(ip);
    SUSPICIOUS_IPS.delete(ip);
  }
}

module.exports = Firewall;
