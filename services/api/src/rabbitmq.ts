import amqp from 'amqplib';

export async function pingRabbitMq(url: string): Promise<void> {
  const connection = await amqp.connect(url);
  await connection.close();
}
