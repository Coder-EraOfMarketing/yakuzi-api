import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Tickets')
@ApiBearerAuth('JWT-auth')
@Controller('tickets')
@UseGuards(JwtAuthGuard)
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a support ticket' })
  @ApiResponse({ status: 201, description: 'Ticket created' })
  createTicket(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTicketDto,
  ) {
    return this.ticketsService.createTicket(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get tickets (own for buyer/seller, all for admin)',
  })
  @ApiResponse({ status: 200, description: 'Tickets list returned' })
  getTickets(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: any,
  ) {
    return this.ticketsService.getTickets(userId, role);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a ticket by ID with all its messages' })
  @ApiResponse({ status: 200, description: 'Ticket found' })
  getTicketById(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: any,
    @Param('id', ParseUUIDPipe) ticketId: string,
  ) {
    return this.ticketsService.getTicketById(userId, role, ticketId);
  }

  @Patch(':id/close')
  @ApiOperation({
    summary: 'Close a ticket — the buyer who raised it, or support',
  })
  @ApiResponse({ status: 200, description: 'Ticket closed' })
  @ApiResponse({ status: 403, description: 'Ticket belongs to another account' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  closeTicket(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: any,
    @Param('id', ParseUUIDPipe) ticketId: string,
  ) {
    return this.ticketsService.closeTicket(userId, role, ticketId);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Add a message to a ticket' })
  @ApiResponse({ status: 201, description: 'Message added' })
  addMessage(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: any,
    @Param('id', ParseUUIDPipe) ticketId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.ticketsService.addMessage(userId, role, ticketId, dto);
  }
}
