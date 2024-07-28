import { Controller, Get } from '@nestjs/common';
import { ProductService } from './product.service';
import { Product } from './entity/product.entity';

@Controller('product')
export class ProductController {
  
  constructor(private readonly productService: ProductService) {}

  @Get()
  async findAll(): Promise<Product[]> {
    return this.productService.findAll();
  }
}