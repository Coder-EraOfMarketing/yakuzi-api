import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FacebookLoginDto {
  @ApiProperty({
    example: 'EAAGm0PX4ZCps...',
    description: 'The user access token returned by FB.login on the client.',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;
}
