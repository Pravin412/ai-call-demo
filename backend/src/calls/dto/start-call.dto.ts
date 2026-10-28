import { IsString, IsNotEmpty } from 'class-validator';

export class StartCallDto {
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  appointmentId: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
