// backend/bot/steamBot.js
import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import SteamCommunity from 'steamcommunity';
import TradeOfferManager from 'tradeoffer-manager';
import { query } from '../database/db.js';
import axios from 'axios';

class SteamBot {
  constructor() {
    this.client = new SteamUser({
      promptSteamGuardCode: false,
      dataDirectory: './steamdata',
      autoRelogin: true
    });
    
    this.community = new SteamCommunity();
    this.manager = new TradeOfferManager({
      steam: this.client,
      community: this.community,
      language: 'en',
      pollInterval: parseInt(process.env.TRADE_POLL_INTERVAL) || 30000,
      cancelTime: parseInt(process.env.TRADE_CONFIRM_TIMEOUT) || 300000
    });
    
    this.isLoggedIn = false;
    this.botSteamId = process.env.BOT_STEAM_ID;
    this.commissionRate = parseFloat(process.env.COMMISSION_RATE) || 0.03;
    this.steamPriceCache = new Map();
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Steam client handlers
    this.client.on('loggedOn', () => {
      console.log('🤖 Steam bot успешно вошел в систему');
      this.isLoggedIn = true;
      this.client.setPersona(SteamUser.EPersonaState.Online);
      this.client.gamesPlayed([730, 570]); // CS2 и Dota 2
    });

    this.client.on('error', (error) => {
      console.error('Steam bot error:', error);
      this.isLoggedIn = false;
    });

    this.client.on('steamGuard', (domain, callback) => {
      console.log('🔐 Steam Guard required');
      const code = SteamTotp.generateAuthCode(process.env.BOT_SHARED_SECRET);
      callback(code);
    });

    // Trade Offer Manager handlers
    this.manager.on('newOffer', (offer) => {
      console.log('📦 Получен новый трейд оффер:', offer.id);
      this.handleNewOffer(offer);
    });

    this.manager.on('sentOfferChanged', (offer, oldState) => {
      console.log(`🔄 Статус оффера ${offer.id} изменился: ${oldState} -> ${offer.state}`);
      this.updateOfferInDatabase(offer);
    });

    this.manager.on('receivedOfferChanged', (offer, oldState) => {
      console.log(`🔄 Входящий оффер ${offer.id} изменился: ${oldState} -> ${offer.state}`);
      if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
        this.handleAcceptedOffer(offer);
      }
    });
  }

  // Логин бота
  async login() {
    try {
      const logOnOptions = {
        accountName: process.env.BOT_USERNAME,
        password: process.env.BOT_PASSWORD,
        twoFactorCode: SteamTotp.getAuthCode(process.env.BOT_SHARED_SECRET)
      };

      this.client.logOn(logOnOptions);
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout during login'));
        }, 30000);

        this.client.once('loggedOn', () => {
          clearTimeout(timeout);
          this.community.startConfirmationChecker(
            parseInt(process.env.TRADE_POLL_INTERVAL) || 30000,
            process.env.BOT_IDENTITY_SECRET
          );
          resolve();
        });

        this.client.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    } catch (error) {
      console.error('Bot login error:', error);
      throw error;
    }
  }

  // Создание трейд оффера для выдачи предмета покупателю
  async createSellOffer(partnerSteamId, itemData) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Бот не авторизован');
      }

      const offer = this.manager.createOffer(partnerSteamId);
      
      // Добавляем предмет который бот отдает (продажа)
      offer.addMyItem({
        appid: itemData.appid || 730,
        contextid: itemData.contextid || '2',
        assetid: itemData.assetid
      });

      // Устанавливаем сообщение
      offer.setMessage(`Покупка предмета на skinssale.kz - ${new Date().toLocaleString('ru-RU')}`);

      // Отправляем оффер
      return new Promise((resolve, reject) => {
        offer.send((err, status) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              tradeOfferId: offer.id,
              state: offer.state,
              status: status,
              tradeUrl: offer.getOfferUrl()
            });
          }
        });
      });

    } catch (error) {
      console.error('Create sell offer error:', error);
      throw error;
    }
  }

  // Создание трейд оффера для покупки предмета у пользователя
  async createBuyOffer(partnerSteamId, itemData, price) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Бот не авторизован');
      }

      const offer = this.manager.createOffer(partnerSteamId);
      
      // Добавляем предмет который бот получает (покупка)
      offer.addTheirItem({
        appid: itemData.appid || 730,
        contextid: itemData.contextid || '2',
        assetid: itemData.assetid
      });

      // Устанавливаем сообщение
      offer.setMessage(`Продажа предмета на skinssale.kz - ${new Date().toLocaleString('ru-RU')}`);

      // Отправляем оффер
      return new Promise((resolve, reject) => {
        offer.send((err, status) => {
          if (err) {
            reject(err);
          } else {
            // Создаем запись в базе о покупке
            this.createBuyTransaction(offer.id, partnerSteamId, itemData, price);
            
            resolve({
              tradeOfferId: offer.id,
              state: offer.state,
              status: status,
              price: price,
              commission: price * this.commissionRate,
              finalAmount: price * (1 - this.commissionRate)
            });
          }
        });
      });

    } catch (error) {
      console.error('Create buy offer error:', error);
      throw error;
    }
  }

  // Обработка входящих офферов
  async handleNewOffer(offer) {
    try {
      console.log('🔍 Анализируем входящий оффер:', offer.id);
      
      // Получаем предметы из оффера
      const myItems = offer.itemsToGive || [];
      const theirItems = offer.itemsToReceive || [];
      
      // Определяем тип трейда
      // Если бот получает предметы - это покупка
      // Если бот отдает предметы - это продажа (должен быть только один предмет)
      
      if (theirItems.length > 0 && myItems.length === 0) {
        // Покупка предмета у пользователя
        await this.handleBuyOffer(offer, theirItems);
      } else if (myItems.length === 1 && theirItems.length === 0) {
        // Продажа предмета пользователю - проверяем что это наш оффер
        const isValid = await this.validateSellOffer(offer, myItems[0]);
        if (isValid) {
          console.log('✅ Принимаем оффер на продажу:', offer.id);
          await offer.accept();
        } else {
          console.log('❌ Отклоняем оффер на продажу:', offer.id);
          await offer.decline();
        }
      } else {
        // Неизвестный тип оффера - отклоняем
        console.log('❌ Отклоняем неизвестный оффер:', offer.id);
        await offer.decline();
      }

    } catch (error) {
      console.error('Handle new offer error:', error);
      await offer.decline();
    }
  }

  // Обработка оффера на покупку
  async handleBuyOffer(offer, items) {
    try {
      const partnerSteamId = offer.partner.getSteamID64();
      
      // Проверяем что в оффере только один предмет
      if (items.length !== 1) {
        console.log('❌ Отклоняем оффер: должно быть ровно один предмет');
        await offer.decline();
        return;
      }

      const item = items[0];
      
      // Получаем информацию о предмете
      const itemInfo = await this.getItemInfo(item);
      
      // Рассчитываем цену покупки
      const buyPrice = await this.calculateBuyPrice(itemInfo);
      
      if (buyPrice <= 0) {
        console.log('❌ Отклоняем оффер: цена покупки не определена');
        await offer.decline();
        return;
      }

      // Проверяем пользователя
      const userResult = await query(
        'SELECT id, is_active FROM users WHERE steam_id = $1',
        [partnerSteamId]
      );

      if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
        console.log('❌ Отклоняем оффер: пользователь не найден или заблокирован');
        await offer.decline();
        return;
      }

      // Принимаем оффер
      console.log(`✅ Принимаем оффер на покупку: ${itemInfo.name} за ${buyPrice} USD`);
      await offer.accept();
      
      // Создаем транзакцию покупки
      await this.createBuyTransaction(offer.id, partnerSteamId, item, buyPrice);

    } catch (error) {
      console.error('Handle buy offer error:', error);
      await offer.decline();
    }
  }

  // Валидация оффера на продажу
  async validateSellOffer(offer, item) {
    try {
      // Проверяем что оффер создан нашей системой
      const transactionResult = await query(
        'SELECT id FROM transactions WHERE trade_offer_id = $1 AND type = $2',
        [offer.id, 'sell']
      );

      return transactionResult.rows.length > 0;

    } catch (error) {
      console.error('Validate sell offer error:', error);
      return false;
    }
  }

  // Обработка принятого оффера
  async handleAcceptedOffer(offer) {
    try {
      const transactionResult = await query(
        'SELECT * FROM transactions WHERE trade_offer_id = $1',
        [offer.id]
      );

      if (transactionResult.rows.length === 0) {
        return;
      }

      const transaction = transactionResult.rows[0];
      
      if (transaction.type === 'buy') {
        // Покупка предмета у пользователя завершена
        await this.completeBuyTransaction(offer.id);
      } else if (transaction.type === 'sell') {
        // Продажа предмета пользователю завершена
        await this.completeSellTransaction(offer.id);
      }

    } catch (error) {
      console.error('Handle accepted offer error:', error);
    }
  }

  // Создание транзакции покупки
  async createBuyTransaction(tradeOfferId, steamId, itemData, price) {
    try {
      const itemInfo = await this.getItemInfo(itemData);
      
      await query(
        `INSERT INTO transactions (
          trade_offer_id, user_steam_id, type, status, 
          item_name, item_image, item_assetid, price, 
          commission, final_amount, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [
          tradeOfferId,
          steamId,
          'buy',
          'pending',
          itemInfo.name,
          itemInfo.image_url,
          itemData.assetid,
          price,
          price * this.commissionRate,
          price * (1 - this.commissionRate)
        ]
      );

      console.log(`📝 Создана транзакция покупки: ${itemInfo.name} за ${price} USD`);

    } catch (error) {
      console.error('Create buy transaction error:', error);
    }
  }

  // Завершение транзакции покупки
  async completeBuyTransaction(tradeOfferId) {
    try {
      // Получаем данные транзакции
      const transactionResult = await query(
        'SELECT * FROM transactions WHERE trade_offer_id = $1 AND type = $2',
        [tradeOfferId, 'buy']
      );

      if (transactionResult.rows.length === 0) {
        return;
      }

      const transaction = transactionResult.rows[0];
      
      // Обновляем статус транзакции
      await query(
        'UPDATE transactions SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', transaction.id]
      );

      // Начисляем средства на баланс пользователя
      await query(
        'UPDATE users SET balance = balance + $1 WHERE steam_id = $2',
        [transaction.final_amount, transaction.user_steam_id]
      );

      // Добавляем предмет в инвентарь бота
      await this.addItemToBotInventory(transaction);

      console.log(`✅ Транзакция покупки завершена: ${transaction.item_name}`);

      // Отправляем уведомление пользователю
      await this.sendNotification(transaction.user_steam_id, {
        type: 'buy_completed',
        amount: transaction.final_amount,
        item_name: transaction.item_name
      });

    } catch (error) {
      console.error('Complete buy transaction error:', error);
    }
  }

  // Создание транзакции продажи
  async createSellTransaction(userId, itemId, tradeOfferId) {
    try {
      // Получаем данные о предмете
      const itemResult = await query(
        'SELECT * FROM items WHERE id = $1',
        [itemId]
      );

      if (itemResult.rows.length === 0) {
        throw new Error('Item not found');
      }

      const item = itemResult.rows[0];
      
      // Получаем информацию о предмете в инвентаре бота
      const inventoryItem = await this.getInventoryItemByName(item.market_hash_name);
      
      if (!inventoryItem) {
        throw new Error('Item not found in bot inventory');
      }

      // Создаем транзакцию
      await query(
        `INSERT INTO transactions (
          trade_offer_id, user_id, type, status, 
          item_name, item_image, item_assetid, price,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          tradeOfferId,
          userId,
          'sell',
          'pending',
          item.name,
          item.image_url,
          inventoryItem.assetid,
          item.price
        ]
      );

      console.log(`📝 Создана транзакция продажи: ${item.name} за ${item.price}`);

    } catch (error) {
      console.error('Create sell transaction error:', error);
      throw error;
    }
  }

  // Завершение транзакции продажи
  async completeSellTransaction(tradeOfferId) {
    try {
      // Обновляем статус транзакции
      await query(
        'UPDATE transactions SET status = $1, completed_at = NOW() WHERE trade_offer_id = $2',
        ['completed', tradeOfferId]
      );

      // Удаляем предмет из инвентаря бота
      await this.removeItemFromBotInventory(tradeOfferId);

      console.log(`✅ Транзакция продажи завершена`);

    } catch (error) {
      console.error('Complete sell transaction error:', error);
    }
  }

  // Добавление предмета в инвентарь бота (в БД)
  async addItemToBotInventory(transaction) {
    try {
      await query(
        `INSERT INTO bot_inventory (
          assetid, appid, contextid, market_hash_name,
          name, image_url, price, transaction_id, added_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          transaction.item_assetid,
          730, // CS2 appid
          '2', // CS2 contextid
          transaction.item_name,
          transaction.item_name,
          transaction.item_image,
          transaction.price,
          transaction.id
        ]
      );

      // Обновляем наличие предмета в каталоге
      await this.updateItemAvailability(transaction.item_name, true);

    } catch (error) {
      console.error('Add item to bot inventory error:', error);
    }
  }

  // Удаление предмета из инвентаря бота
  async removeItemFromBotInventory(tradeOfferId) {
    try {
      const transactionResult = await query(
        'SELECT item_assetid, item_name FROM transactions WHERE trade_offer_id = $1',
        [tradeOfferId]
      );

      if (transactionResult.rows.length === 0) {
        return;
      }

      const { item_assetid, item_name } = transactionResult.rows[0];

      // Удаляем из инвентаря бота
      await query(
        'DELETE FROM bot_inventory WHERE assetid = $1',
        [item_assetid]
      );

      // Обновляем наличие предмета в каталоге
      await this.updateItemAvailability(item_name, false);

    } catch (error) {
      console.error('Remove item from bot inventory error:', error);
    }
  }

  // Обновление наличия предмета в каталоге
  async updateItemAvailability(itemName, isAvailable) {
    try {
      await query(
        'UPDATE items SET is_available = $1, updated_at = NOW() WHERE market_hash_name = $2',
        [isAvailable, itemName]
      );

      console.log(`🔄 Обновлено наличие: ${itemName} - ${isAvailable ? 'в наличии' : 'нет в наличии'}`);

    } catch (error) {
      console.error('Update item availability error:', error);
    }
  }

  // Получение информации о предмете
  async getItemInfo(item) {
    try {
      // Здесь можно реализовать получение информации о предмете
      // из Steam API или из локальной базы
      return {
        name: 'Unknown Item',
        image_url: '',
        market_hash_name: ''
      };
    } catch (error) {
      console.error('Get item info error:', error);
      return {
        name: 'Unknown Item',
        image_url: '',
        market_hash_name: ''
      };
    }
  }

  // Расчет цены покупки
  async calculateBuyPrice(itemInfo) {
    try {
      // Получаем среднюю цену с маркетплейса
      const marketPrice = await this.getMarketPrice(itemInfo.market_hash_name);
      
      if (!marketPrice) {
        return 0;
      }

      // Применяем комиссию
      const buyPrice = marketPrice * (1 - this.commissionRate);
      
      return parseFloat(buyPrice.toFixed(2));

    } catch (error) {
      console.error('Calculate buy price error:', error);
      return 0;
    }
  }

  // Получение цены с маркетплейса
  async getMarketPrice(marketHashName) {
    try {
      // Проверяем кэш
      if (this.steamPriceCache.has(marketHashName)) {
        const cached = this.steamPriceCache.get(marketHashName);
        if (Date.now() - cached.timestamp < parseInt(process.env.STEAM_PRICE_CACHE_TIME) || 3600000) {
          return cached.price;
        }
      }

      // Получаем цену из Steam API
      const response = await axios.get(
        `https://steamcommunity.com/market/priceoverview/`,
        {
          params: {
            country: 'RU',
            currency: 5, // RUB
            appid: 730, // CS2
            market_hash_name: marketHashName
          }
        }
      );

      if (response.data && response.data.lowest_price) {
        const priceStr = response.data.lowest_price.replace(/[^0-9.,]/g, '').replace(',', '.');
        const price = parseFloat(priceStr);
        
        // Конвертируем RUB в USD (примерный курс)
        const priceUSD = price / 90; // 90 RUB за 1 USD
        
        // Сохраняем в кэш
        this.steamPriceCache.set(marketHashName, {
          price: priceUSD,
          timestamp: Date.now()
        });

        return priceUSD;
      }

      return null;

    } catch (error) {
      console.error('Get market price error:', error);
      return null;
    }
  }

  // Получение предмета из инвентаря бота по названию
  async getInventoryItemByName(marketHashName) {
    try {
      const result = await query(
        'SELECT * FROM bot_inventory WHERE market_hash_name = $1 LIMIT 1',
        [marketHashName]
      );

      return result.rows.length > 0 ? result.rows[0] : null;

    } catch (error) {
      console.error('Get inventory item by name error:', error);
      return null;
    }
  }

  // Отправка уведомления
  async sendNotification(steamId, data) {
    try {
      // Здесь можно реализовать отправку уведомления
      // через WebSocket или сохранить в базу для фронтенда
      await query(
        `INSERT INTO notifications (user_steam_id, type, data, is_read, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [steamId, data.type, JSON.stringify(data), false]
      );

    } catch (error) {
      console.error('Send notification error:', error);
    }
  }

  // Получение инвентаря бота
  async getBotInventory(appId = 730, contextId = 2) {
    try {
      return new Promise((resolve, reject) => {
        this.manager.getInventoryContents(this.botSteamId, appId, contextId, true, (err, inventory) => {
          if (err) {
            reject(err);
          } else {
            resolve(inventory);
          }
        });
      });
    } catch (error) {
      console.error('Get bot inventory error:', error);
      throw error;
    }
  }

  // Обновление статуса оффера в базе данных
  async updateOfferStatus(tradeOfferId, status) {
    try {
      await query(
        'UPDATE transactions SET status = $1, updated_at = NOW() WHERE trade_offer_id = $2',
        [status, tradeOfferId]
      );
      console.log(`📊 Обновлен статус оффера ${tradeOfferId}: ${status}`);
    } catch (error) {
      console.error('Update offer status error:', error);
    }
  }

  // Обновление оффера в базе данных
  async updateOfferInDatabase(offer) {
    try {
      await this.updateOfferStatus(offer.id, offer.state);
    } catch (error) {
      console.error('Update offer in database error:', error);
    }
  }
}

export const steamBot = new SteamBot();
