// backend/bot/steamBot.js
import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import SteamCommunity from 'steamcommunity';
import TradeOfferManager from 'tradeoffer-manager';

class SteamBot {
  constructor() {
    this.client = new SteamUser();
    this.community = new SteamCommunity();
    this.manager = new TradeOfferManager({
      steam: this.client,
      community: this.community,
      language: 'en'
    });
    
    this.isLoggedIn = false;
    this.botSteamId = process.env.BOT_STEAM_ID;
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Обработчики Steam клиента
    this.client.on('loggedOn', () => {
      console.log('🤖 Steam бот успешно вошел в систему');
      this.isLoggedIn = true;
      this.client.setPersona(SteamUser.EPersonaState.Online);
    });

    this.client.on('error', (error) => {
      console.error('Steam bot error:', error);
      this.isLoggedIn = false;
    });

    // Обработчики Trade Offer Manager
    this.manager.on('newOffer', (offer) => {
      console.log('📦 Получен новый трейд оффер:', offer.id);
      this.handleNewOffer(offer);
    });

    this.manager.on('sentOfferChanged', (offer, oldState) => {
      console.log(`🔄 Статус оффера ${offer.id} изменился: ${oldState} -> ${offer.state}`);
      this.updateOfferInDatabase(offer);
    });
  }

  // Логин бота
  async login() {
    try {
      const logOnOptions = {
        accountName: process.env.BOT_USERNAME,
        password: process.env.BOT_PASSWORD,
        twoFactorCode: SteamTotp.generateAuthCode(process.env.BOT_SHARED_SECRET)
      };

      this.client.logOn(logOnOptions);
      
      // Ждем логин
      return new Promise((resolve, reject) => {
        this.client.once('loggedOn', () => resolve());
        this.client.once('error', reject);
        
        // Таймаут
        setTimeout(() => reject(new Error('Timeout during login')), 30000);
      });
    } catch (error) {
      console.error('Bot login error:', error);
      throw error;
    }
  }

  // Создание трейд оффера
  async createTradeOffer(partnerSteamId, itemsToGive = [], itemsToReceive = []) {
    try {
      if (!this.isLoggedIn) {
        throw new Error('Бот не авторизован');
      }

      const offer = this.manager.createOffer(partnerSteamId);
      
      // Добавляем предметы которые бот отдает
      for (const item of itemsToGive) {
        offer.addMyItem({
          appid: item.appid || 730,
          contextid: item.contextid || '2',
          assetid: item.assetid
        });
      }

      // Добавляем предметы которые бот получает
      for (const item of itemsToReceive) {
        offer.addTheirItem({
          appid: item.appid || 730,
          contextid: item.contextid || '2',
          assetid: item.assetid
        });
      }

      // Устанавливаем сообщение
      offer.setMessage(`Трейд через skinsale.kz - ${new Date().toLocaleString()}`);

      // Отправляем оффер
      return new Promise((resolve, reject) => {
        offer.send((err, status) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              tradeOfferId: offer.id,
              state: offer.state,
              status: status
            });
          }
        });
      });

    } catch (error) {
      console.error('Create trade offer error:', error);
      throw error;
    }
  }

  // Обработка входящих офферов
  async handleNewOffer(offer) {
    try {
      console.log('🔍 Анализируем входящий оффер:', offer.id);
      
      // Получаем предметы из оффера
      const myItems = offer.itemsToGive;
      const theirItems = offer.itemsToReceive;

      // Проверяем оффер (здесь можно добавить бизнес-логику)
      const isValid = await this.validateOffer(offer);
      
      if (isValid) {
        console.log('✅ Принимаем оффер:', offer.id);
        await offer.accept();
        
        // Обновляем статус в базе данных
        await this.updateOfferStatus(offer.id, 'accepted');
      } else {
        console.log('❌ Отклоняем оффер:', offer.id);
        await offer.decline();
        
        // Обновляем статус в базе данных
        await this.updateOfferStatus(offer.id, 'declined');
      }

    } catch (error) {
      console.error('Handle new offer error:', error);
      await offer.decline();
    }
  }

  // Валидация оффера
  async validateOffer(offer) {
    try {
      // Здесь можно добавить сложную логику валидации
      // Например: проверка стоимости предметов, белый список пользователей и т.д.
      
      const myItems = offer.itemsToGive;
      const theirItems = offer.itemsToReceive;

      // Пример простой валидации - проверяем что бот получает предметы
      if (theirItems.length === 0) {
        return false;
      }

      // Проверяем что пользователь существует в нашей базе
      const userResult = await query(
        'SELECT id FROM users WHERE steam_id = $1 AND is_active = true',
        [offer.partner.getSteamID64()]
      );

      if (userResult.rows.length === 0) {
        return false;
      }

      return true;

    } catch (error) {
      console.error('Offer validation error:', error);
      return false;
    }
  }

  // Обновление статуса оффера в базе данных
  async updateOfferStatus(tradeOfferId, status) {
    try {
      await query(
        'UPDATE trades SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE trade_offer_id = $2',
        [status, tradeOfferId]
      );
      console.log(`📊 Обновлен статус оффера ${tradeOfferId}: ${status}`);
    } catch (error) {
      console.error('Update offer status error:', error);
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
}

export const steamBot = new SteamBot();
