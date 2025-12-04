// services/paymentProxy.js - ES MODULES ВЕРСИЯ
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Получаем __dirname для ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Конфигурация платежного шлюза
export const PAYMENT_CONFIG = {
  // ПРАВИЛЬНЫЙ ПУТЬ К СЕРТИФИКАТУ
  pfx: fs.readFileSync(path.join(process.cwd(), 'certs/1web.p12')),
  passphrase: 'Uc6+ijvX9BeN',
  apiBaseUrl: 'sandboxapi.paymtech.kz',
  auth: {
    username: '1web',
    password: 'nTTzD7alv50FqOsl'
  }
};

// Функция для HTTPS запросов с SSL сертификатом
export function makePaymentRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: PAYMENT_CONFIG.apiBaseUrl,
      port: 443,
      pfx: PAYMENT_CONFIG.pfx,
      passphrase: PAYMENT_CONFIG.passphrase,
      rejectUnauthorized: false,
      ...options,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${PAYMENT_CONFIG.auth.username}:${PAYMENT_CONFIG.auth.password}`).toString('base64'),
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          resolve({
            statusCode: res.statusCode,
            data: parsedData,
            headers: res.headers
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            data: data,
            headers: res.headers
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

// Дополнительные утилиты для платежей
export const paymentUtils = {
  // Генерация order_id
  generateOrderId: (userId, type = 'deposit') => {
    return `${type}_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },
  
  // Проверка статуса платежа
  isSuccessStatus: (status) => {
    return ['charged', 'authorized', 'completed'].includes(status);
  },
  
  isPendingStatus: (status) => {
    return ['pending', 'processing', 'authorized'].includes(status);
  },
  
  isFailedStatus: (status) => {
    return ['declined', 'failed', 'canceled'].includes(status);
  },
  
  // Форматирование суммы
  formatAmount: (amount, currency) => {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: currency
    }).format(amount);
  }
};

// Экспорт по умолчанию для обратной совместимости
export default {
  makePaymentRequest,
  PAYMENT_CONFIG,
  paymentUtils
};
