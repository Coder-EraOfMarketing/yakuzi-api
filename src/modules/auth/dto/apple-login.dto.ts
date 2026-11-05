import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AppleLoginDto {
  @ApiProperty({
    example: 'eyJraWQiOiJmaDZCczhDIiwiYWxnIjoiUlMyNTYifQ...',
    description:
      'The identity token (id_token) returned by Sign in with Apple on the client. Not the authorization code.',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}
