import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pay } from './entity/pay.entity';
import { User } from './../user/entity/user';
import { Order } from './../order/entity/order'; 
import { PayLog } from './entity/pay-log.entity';
import { PayConstants, ErrorConstants } from './config/pay.constants';
import { Keys } from './config/gateway-keys.constants';
import { Urls } from './config/gateway-urls.constants';
import axios from 'axios';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PayService {
  
  constructor(
    @InjectRepository(Pay)
    private readonly payRepository: Repository<Pay>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(PayLog)
    private readonly payLogRepository: Repository<PayLog>,
  ) {}

  async createTransaction(orderId: number): Promise<any> {
    const order = await this.orderRepository.findOneBy({ id: orderId });
  
    if (!order) {
      return PayConstants.ORDER_NOT_FOUND;
    }
  
    try {
      const transaction = new Pay();
      transaction.total_cost = order.total_cost;
      transaction.status = 0; // 0 para pendiente
      transaction.order_id = orderId;
  
      const uniqueReference = `eve${uuidv4()}`;
      transaction.reference = uniqueReference;
  
      const savedTransaction = await this.payRepository.save(transaction);
  
      return PayConstants.TRANSACTION_CREATED(savedTransaction.id, savedTransaction.reference);
    } catch (error) {
      return PayConstants.TRANSACTION_CREATION_FAILED;
    }
  }

  async getAcceptanceToken(): Promise<any> {
    try {
      const url = Urls.URL_ACCEPTANCE_TOKEN + Keys.PUBLIC_KEY;
      const response = await axios.get(url);
      
      const { acceptance_token, permalink } = response.data.data.presigned_acceptance;
      return { acceptance_token, permalink };
    } catch {
      return PayConstants.REQUEST_ACCEPTANCE_TOKEN_FAILED;
    }
  }

  private validateCardDetails(number: string, cvc: string, exp_month: string, exp_year: string, card_holder: string) {
    const cardNumberPattern = /^\d{16}$/;
    const cvcPattern = /^\d{3,4}$/;
    const expMonthPattern = /^(0[1-9]|1[0-2])$/;
    const expYearPattern = /^\d{2}$|^\d{4}$/;

    if (!cardNumberPattern.test(number)) {
      return PayConstants.CARD_NUMBER_INVALID;
    }
    if (!cvcPattern.test(cvc)) {
      return PayConstants.CVC_INVALID;
    }
    if (!expMonthPattern.test(exp_month)) {
      return PayConstants.EXP_MONTH_INVALID;
    }
    if (!expYearPattern.test(exp_year)) {
      return PayConstants.EXP_YEAR_INVALID;
    }
    if (!card_holder) {
      return PayConstants.CARD_HOLDER_REQUIRED;
    }
    return null;
  }

  async tokenizeCard(cardDetails: { number: string, cvc: string, exp_month: string, exp_year: string, card_holder: string }): Promise<any> {
    const { number, cvc, exp_month, exp_year, card_holder } = cardDetails;
    const validationError = this.validateCardDetails(number, cvc, exp_month, exp_year, card_holder);
    if (validationError) {
      return validationError;
    }

    try {
      const response = await axios.post(Urls.URL_TOKENIZE_CARD, { number, cvc, exp_month, exp_year, card_holder }, {
        headers: {
          Authorization: `Bearer ${Keys.PUBLIC_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const { id } = response.data.data;
      return { id };
    } catch (error) {
      if (error.response) {
        return ErrorConstants.SERVER_ERROR;
      } else if (error.request) {
        return ErrorConstants.NO_RESPONSE;
      } else {
        return ErrorConstants.REQUEST_SETUP_ERROR;
      }
    }
  }

  async createGatewayTransaction(data: { reference: string, installments: number, acceptance_token: string, id_tokenizacion: string }): Promise<any> {
    const { reference, installments, acceptance_token, id_tokenizacion } = data;

    const transaction = await this.payRepository.findOne({
      where: { reference },
      relations: ['order', 'order.user'],
    });

    if (!transaction || !transaction.order) {
      return PayConstants.ORDER_NOT_FOUND;
    }

    const order = transaction.order;

    if (!order.user) {
      return PayConstants.ORDER_NOT_FOUND;
    }

    const user = await this.userRepository.findOne({
      where: { id: order.user.id },
    });

    if (!user) {
      return PayConstants.ORDER_NOT_FOUND;
    }

    const totalInCents = order.total_cost * 100;
    const currency = 'COP';
    const signature = this.generateSignature(reference, totalInCents, currency);

    const url = Urls.URL_CREATE_TRANSACTION;

    try {
      const response = await axios.post(url, {
        acceptance_token,
        amount_in_cents: totalInCents,
        currency,
        signature,
        customer_email: user.email,
        reference,
        payment_method: {
          type: 'CARD',
          installments,
          token: id_tokenizacion,
          sandbox_status: 'APPROVED',
          // sandbox_status: 'PENDING',
        },
      }, {
        headers: {
          'Authorization': `Bearer ${Keys.PUBLIC_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const responseData = response.data;

      if (responseData && responseData.data && responseData.data.id) {
        return { id: responseData.data.id };
      }

      return responseData;
    } catch (error) {
      return this.handleAxiosError(error);
    }
  }

  private generateSignature(reference: string, amountInCents: number, currency: string): string {
    const integrityKey = Keys.INTEGRITY_KEY;
    const cadenaConcatenada = `${reference}${amountInCents}${currency}${integrityKey}`;
  
    const hash = createHash('sha256');
    hash.update(cadenaConcatenada);
  
    return hash.digest('hex');
  }

  async getTransactionDetails({ idTransaction }: { idTransaction: string;}): Promise<any> {
    try {
      const url = `${Urls.URL_TRANSVERAL}/${idTransaction}`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${Keys.PRIVATE_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      
      await this.saveLogTransaction({
        reference: response.data.data.reference,
        status: response.data.data.status,
        data_out: JSON.stringify(response.data),
      });

      if (response.data.data.status === 'APPROVED') {
        const paymentMethod = response.data.data.payment_method;
        return {
          reference: response.data.data.reference,
          type: paymentMethod.type,
          finalized_at: response.data.data.finalized_at,
          brand: paymentMethod.extra.brand,
          id: response.data.data.id,
          status: response.data.data.status,
        };
      } else {
        return { status: response.data.status };
      }
    } catch (error) {
      return this.handleAxiosError(error);
    }
  }

  private async saveLogTransaction({ reference, status, data_out }: { reference: string; status: string; data_out: string }): Promise<void> {
    await this.payLogRepository.save({
      reference,
      status,
      data_out,
      created_at: new Date(),
    });
  }

  async updateTransaction({reference, type, finalized_at, brand, id, status, }: {
    reference: string;
    type: string;
    finalized_at: string;
    brand: string;
    id: string;
    status: string;
  }): Promise<any> {
    try {
      const transaction = await this.payRepository.findOneBy({ reference });

      if (!transaction) {
        return PayConstants.TRANSACTION_NOT_FOUND;
      }

      transaction.payment_method = type;
      transaction.payment_date = new Date(finalized_at);
      transaction.franchise = brand;
      transaction.cus = id;

      transaction.status = status === 'APPROVED' ? 1 : transaction.status;

      await this.payRepository.save(transaction);

      return PayConstants.TRANSACTION_UPDATE_SUCCESS;
    } catch (error) {
      return {
        ...PayConstants.TRANSACTION_UPDATE_FAILED,
        message: `${ErrorConstants.REQUEST_SETUP_ERROR.message}: ${error.message}`,
      };
    }
  }

  private handleAxiosError(error: any): any {
    if (error.response) {
      const { status, data } = error.response;
  
      if (status === 422 && data.error && data.error.messages) {
        return {
          ...ErrorConstants.VALIDATION_ERROR,
          details: data.error.messages,
        };
      }
  
      if (status >= 400 && status < 500) {
        return {
          ...ErrorConstants.CLIENT_ERROR,
          message: data.message || ErrorConstants.CLIENT_ERROR.message,
        };
      }
  
      if (status >= 500) {
        return ErrorConstants.SERVER_ERROR;
      }
    } else if (error.request) {
      return ErrorConstants.NO_RESPONSE;
    } else {
      return {
        ...ErrorConstants.REQUEST_SETUP_ERROR,
        message: `${ErrorConstants.REQUEST_SETUP_ERROR.message}: ${error.message}`,
      };
    }
  
    return ErrorConstants.CREATE_GATEWAY_TRANSACTION_FAILED;
  }
}
